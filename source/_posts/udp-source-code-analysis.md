---
title: Linux UDP 协议栈源码解析
date: 2026-06-13
categories: [network]
tags: [UDP, Linux, 网络协议栈, 内核]
---

## 概述

UDP（User Datagram Protocol）是传输层最简洁的协议之一。与 TCP 相比，UDP 无连接、不可靠、面向数据报，核心代码量只有 TCP 的十分之一左右。本文以 Linux 内核 v6.x 为主线，分析 UDP 的收发路径。

整体数据流：

```
应用层    sendto()/sendmsg()              recvfrom()/recvmsg()
           ↓                                    ↑
Socket层   udp_sendmsg()                  udp_recvmsg()
           ↓                                    ↑
传输层     udp_push_pending_frames()      __udp4_lib_rcv()
           ↓                                    ↑
网络层     ip_queue_xmit()               ip_local_deliver_finish()
```

## 1. 数据结构

### 1.1 UDP 头部 (8 字节)

```c
// include/uapi/linux/udp.h
struct udphdr {
    __be16  source;   // 源端口
    __be16  dest;     // 目的端口
    __be16  len;      // UDP 数据报总长度 (头部 + 数据)
    __sum16 check;    // 校验和
};
```

### 1.2 UDP Socket 结构

```c
// include/linux/udp.h
struct udp_sock {
    struct inet_sock inet;
    int             pending;        // 待处理的数据报数
    unsigned int    corkflag;       // 是否启用 cork (聚合发送)
    __u8            encap_type;     // 封装类型 (如 UDP_ENCAP_ESPINUDP)
    unsigned int    no_check6_tx:1; // 发送时跳过 IPv6 校验和
    unsigned int    no_check6_rx:1; // 接收时跳过 IPv6 校验和
    unsigned int    gro_enabled:1;  // GRO 使能
};
```

### 1.3 双 Hash 表

UDP 使用两个 hash 表加速 socket 查找：

```c
// net/ipv4/udp.c
struct udp_table {
    struct udp_hslot    *hash;      // 主 hash 表 (端口)
    struct udp_hslot    *hash2;     // 辅助 hash 表 (端口 + 地址)
};

struct udp_hslot {
    struct hlist_head   head;       // socket 链表头
    int                 count;      // 槽内 socket 数量
    spinlock_t          lock;       // 槽级别自旋锁
};
```

`hash` 只对端口取模，`hash2` 额外关联 IP 地址，能更快定位到精确匹配的 socket。

## 2. Socket 创建

```c
// net/ipv4/udp.c
int udp_init_sock(struct sock *sk)
{
    udp_lib_init_sock(sk);
    sk->sk_destruct = udp_destruct_sock();
    return 0;
}

void udp_lib_init_sock(struct sock *sk)
{
    struct udp_sock *up = udp_sk(sk);

    skb_queue_head_init(&up->reader_queue);
    up->pending = 0;
    up->corkflag = 0;
    sk->sk_write_space = udp_write_space;
}
```

UDP socket 初始化非常轻量——没有连接状态机，没有发送/接收缓冲区预分配，也没有拥塞控制。

## 3. 发送路径: udp_sendmsg()

位于 `net/ipv4/udp.c`，核心流程：

```c
int udp_sendmsg(struct sock *sk, struct msghdr *msg, size_t len)
{
    struct inet_sock *inet = inet_sk(sk);
    struct udp_sock *up = udp_sk(sk);

    // 步骤 1: 获取目标地址
    if (msg->msg_name) {
        // 非连接模式：从 msg_name 解析
        daddr = usin->sin_addr.s_addr;
        dport = usin->sin_port;
    } else {
        // 已连接模式：使用保存的地址
        daddr = inet->inet_daddr;
        dport = inet->inet_dport;
    }

    // 步骤 2: 路由查找
    rt = ip_route_output_flow(net, fl4, sk);

    // 步骤 3: 构建 skb
    err = ip_append_data(sk, fl4, udp_getfrag_nosum, msg, ulen);

    // 步骤 4: 如果不是 cork 模式，立即发送
    if (!up->corkflag)
        err = udp_push_pending_frames(sk);
}
```

### Cork 机制

当应用要连续发送多个小数据报时，cork 把数据暂存，等积累到一定量后一次性发送：

```c
// 应用层通过 setsockopt(UDP_CORK) 或 MSG_MORE 标志启用
if (up->corkflag) {
    up->pending++;   // 暂存数据，不立即发送
    return size;
}

// 统一发送
int udp_push_pending_frames(struct sock *sk)
{
    return udp_push_one(sk, up);
}
```

### 校验和计算

覆盖 UDP 头部 + 数据 + 伪头部（源 IP、目标 IP、协议号、UDP 长度）：

```c
static int udp_send_skb(struct sk_buff *skb, struct flowi4 *fl4, ...)
{
    uh = udp_hdr(skb);
    uh->source = inet->inet_sport;
    uh->dest   = fl4->fl4_dport;
    uh->len    = htons(skb->len);
    uh->check  = 0;

    // 校验和包含伪头部
    uh->check = csum_tcpudp_magic(fl4->saddr, fl4->daddr,
                                   skb->len, IPPROTO_UDP, csum);
    return ip_send_skb(skb);
}
```

## 4. 接收路径: __udp4_lib_rcv()

从 IP 层 `ip_local_deliver_finish()` 进入，核心流程分三步：

```c
int __udp4_lib_rcv(struct sk_buff *skb, struct udp_table *udptable, int proto)
{
    uh   = udp_hdr(skb);
    saddr = ip_hdr(skb)->saddr;
    daddr = ip_hdr(skb)->daddr;

    // 步骤 1: 校验和验证
    if (udp_lib_checksum_complete(skb))
        goto csum_error;

    // 步骤 2: 查找目标 socket（双 hash 表）
    sk = __udp4_lib_lookup_skb(skb, uh->source, uh->dest);
    if (!sk)
        goto no_socket;  // → ICMP Port Unreachable

    // 步骤 3: 入队唤醒
    return udp_queue_rcv_skb(sk, skb);
}
```

### Socket 查找策略

```c
struct sock *__udp4_lib_lookup(...)
{
    // 阶段 1: hash2 精确匹配 (addr + port)
    sk = udp4_lib_lookup2(net, saddr, sport, daddr, hnum, ..., slot2, skb);
    if (sk) goto found;

    // 阶段 2: hash 回退匹配 (只按 port，匹配 INADDR_ANY 绑定)
    sk = udp4_lib_lookup2(net, ..., &udptable->hash[hash], skb);
found:
    // SO_REUSEPORT 负载均衡
    if (hlist_count > 1)
        sk = reuseport_select_sock(sk, hash, skb, ...);
    return sk;
}
```

### 入队处理

```c
static int udp_queue_rcv_skb(struct sock *sk, struct sk_buff *skb)
{
    // 接收缓冲区满？丢包
    if (sk_rcvqueues_full(sk, sk->sk_rcvbuf))
        goto drop;

    // 常规路径：加入接收队列
    skb_queue_tail(&sk->sk_receive_queue, skb);

    // 唤醒阻塞在 recvfrom() 的进程
    sk->sk_data_ready(sk);
    return 0;
}
```

### 应用层读取: udp_recvmsg()

```c
int udp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, ...)
{
    // 从队列取 skb
    skb = __skb_recv_udp(sk, flags, noblock, &err, &off);

    // 拷贝数据到用户态
    err = skb_copy_datagram_msg(skb, 0, msg, copied);

    // 填充源地址 (for recvfrom)
    if (msg->msg_name) {
        sin->sin_port = udp_hdr(skb)->source;
        sin->sin_addr.s_addr = ip_hdr(skb)->saddr;
    }

    skb_consume_udp(sk, skb, copied);
    return copied;
}
```

## 5. 性能优化

**SO_REUSEPORT**：多个 socket 绑定同一 (地址, 端口)，内核按数据报 hash 分发到不同 socket，利用多核。

**GRO**：NAPI 软中断中合并同流连续 UDP 数据报，减少协议栈处理次数。

**UDP LITE**：只校验部分数据，适合视频流等容忍少量数据损坏的场景。

## 6. 与 TCP 的关键区别

| 特性 | UDP | TCP |
|------|-----|-----|
| 连接状态 | 无 | 三次握手 + 状态机 |
| 可靠性 | 无确认/重传 | 序号 + ACK |
| 流量控制 | 无 | 滑动窗口 |
| 拥塞控制 | 无 | 慢启动、拥塞避免 |
| 头部大小 | 8 字节 | 20-60 字节 |
| 发送路径 | ~400 行 | ~3000+ 行 |

## 总结

UDP 内核实现围绕三个核心函数：`udp_sendmsg()` 构建并发送数据报，`__udp4_lib_rcv()` 校验并查找 socket 入队，`udp_recvmsg()` 从队列取出拷贝到用户态。没有状态机、重传定时器、拥塞窗口——简单即高效，这也是它支撑 DNS、视频流、QUIC/WebRTC 等上层协议的基础。
