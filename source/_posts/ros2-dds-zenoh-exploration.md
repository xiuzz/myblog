---
title: ROS 2 DDS 与 Zenoh 探索
date: 2026-11-23
categories: [network]
tags: [ROS 2, DDS, Zenoh, 通信中间件, 分布式]
---

ROS 2 的通信层被包在一个叫 RMW 的接口后面：上层只调用 `rclcpp`/`rclpy`，底下换成 Fast DDS、CycloneDDS 还是 Zenoh，应用代码一行都不用改。平时这层抽象是透明的，直到网络环境开始变化——机器人接上无线、需要跨公网、节点数量上到几十个，DDS 默认那套多播发现就会从「能用」变成「昂贵」，甚至直接不可用。

这篇想讲清楚三件事：DDS 和 Zenoh 在 ROS 2 里各自扮演什么角色；一个去中心化的通信协议到底怎么完成「发现—建链—发数据」；以及从理论上看，两边的开销差在什么地方。本文不追求给出「谁更快」的结论，那需要实测数据，留到下一篇。

## 0. 为什么还要关心通信层

对写业务逻辑的人来说，通信层是「默认就好」的部分。但一旦跨出单机、单网段，几个问题会集中暴露：

- **发现依赖多播**。DDS 的发现默认走 UDP 多播，多播不跨路由、被防火墙拦截、在 Wi-Fi 上丢包严重时，节点就是互相看不见，而且报错信息通常只有一句「等待匹配」。
- **规模上去了，发现流量跟着涨**。每个参与者都要维护所有对端的状态，节点数翻倍，发现开销按平方级增长。
- **传输被绑在 UDP 上**。UDP 适合局域网低延迟，但跨公网、过 NAT 很难受，还得自己解决穿透和加密。

Zenoh 之所以被 ROS 2 社区拉进来，就是冲着这三点去的。它把「发现」和「传输」都做成了可路由、可配置的东西。

## 1. DDS 与 Zenoh 在 ROS 2 里扮演什么角色

### 1.1 DDS：默认的通信底座

ROS 2 对中间件的依赖被收窄到了 `rmw` 这一层 C 接口：初始化、创建节点、创建发布者/订阅者、发布/订阅、服务与客户端、等待集，全在这组函数里。`rcl` 再往上封装成带生命周期、参数、执行器的客户端库。所以换 RMW 实现，本质上只是换掉最底下那一层。

![ROS 2 通信栈分层](fig-01-stack.png)

*图 1：RMW 把应用和中间件实现隔开，切换只需要改 `RMW_IMPLEMENTATION`*

DDS 的世界里，ROS 2 的每个概念都能找到对应实体，这也是为什么映射关系看起来几乎是一一对应的：

| ROS 2 | DDS 实体 | 说明 |
|---|---|---|
| Node | DomainParticipant | 通常一个 Node 一个 Participant |
| Topic | DDS Topic | 名字 + 类型共同决定身份 |
| Publisher / Subscriber | DataWriter / DataReader | 真正收发数据的是它们 |
| QoS 配置 | QoS Policy | 可靠性、持久性、历史深度等 |
| Service | 一对 request/reply Topic | 请求和应答各走一个 topic |
| Action | 三个 Service + feedback/status Topic | send_goal、get_result、cancel_goal |

![ROS 2 概念与 DDS 实体](fig-02-entity-map.png)

*图 2：talker 的 DataWriter 和 listener 的 DataReader 通过同一个 topic 匹配*

QoS 是 DDS 里最容易被忽视、又最能解释「为什么收不到数据」的部分。ROS 2 的 QoS 设置基本是 DDS 策略的直接映射：

| ROS 2 QoS | DDS 策略 | 典型影响 |
|---|---|---|
| `reliability` | ReliabilityQosPolicy | reliable 与 best_effort 不兼容，配错就匹配不上 |
| `durability` | DurabilityQosPolicy | transient_local 决定晚加入的订阅者能否拿到历史 |
| `history` / `depth` | HistoryQosPolicy | 缓存多少条，丢包时决定补不补得回来 |
| `deadline` | DeadlineQosPolicy | 超时触发回调 |
| `liveliness` | LivelinessQosPolicy | 对端失联的判定方式 |
| `lifespan` | LifespanQosPolicy | 数据过期时间 |

这里有个关键点值得强调：**DDS 是「API + 线协议」两层标准**。API 层各家实现（Fast DDS、CycloneDDS、Connext）并不通用，真正保证互操作的是底下的 RTPS 线协议。ROS 2 选的是 RTPS 这一层的互操作性，这也是 RMW 抽象能够成立的前提。

局限也很清楚：DDS 的默认发现是「同一多播域内的广播」思路，天生假设节点在同一个局域网。跨网段要靠 Discovery Server 之类的集中式方案，跨公网基本没戏。

### 1.2 Zenoh：面向「边缘到云」的另一种协议

Zenoh 是 Eclipse 基金会下的 pub/sub/query 协议，目标场景是「从微控制器到云」的连续体：同一个协议既跑在串口上，也跑在 QUIC 上。它在 ROS 2 语境下的定位不是「DDS 的替代标准」，而是**换一套发现与路由模型**。

它的核心抽象和 DDS 有相似之处，但换了个视角：

- **Key expression 代替 Topic**：`demo/example/**` 这种层级路径，`*` 匹配一层，`**` 匹配任意多层。
- **实体**：publisher、subscriber、queryable、querier。前者是 pub/sub，后者是「提问—应答」，正好对上 ROS 2 的 service。
- **角色**：peer（对等）、router（路由器）、client（只连路由器的轻客户端）。
- **路由**：节点之间不一定直连，消息可以经 router 转发。

对照下来，两边能力的差别可以列成一张表：

| 维度 | DDS | Zenoh |
|---|---|---|
| 匹配依据 | topic 名 + type name + QoS | key expression 交集 |
| 发现方式 | 多播 SPDP + 单播 SEDP | Scouting + router gossip |
| 传输 | 以 UDP 为主，可加共享内存 | TCP / UDP / QUIC / TLS / 共享内存 |
| 跨网 | 需要额外方案（Discovery Server 等） | router 互联即可，天然出网 |
| 服务模型 | request/reply topic | query/queryable |
| 标准化程度 | OMG 标准，多厂商实现 | 单一开源实现（Rust 核心 + 多语言绑定） |

Zenoh 的弱点也在这里：它是单一实现主导的生态，没有 DDS 那种多厂商标准互操作的背书；ROS 2 侧的工具链（录制、可视化、调试）也还在补齐。

### 1.3 rmw_zenoh：把 Zenoh 接进 RMW 接口

`rmw_zenoh` 是 ROS 2 官方的 Zenoh 版 RMW 实现，核心包叫 `rmw_zenoh_cpp`。它的拓扑很直观：每个 ROS 2 节点内部持有一个 Zenoh session，session 连到本机的 Zenoh router；router 之间再互联，跨主机通信就通了。

![rmw_zenoh 的拓扑](fig-03-rmw-zenoh.png)

*图 3：节点只跟 router 建会话，router 负责 gossip 发现和跨主机转发*

先装包，然后最小可运行组合如下：

```bash
sudo apt install ros-$ROS_DISTRO-rmw-zenoh-cpp

# 终端 1：每台主机起一个 router
ros2 run rmw_zenoh_cpp rmw_zenohd

# 终端 2、3：节点侧统一指定 RMW
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
ros2 run demo_nodes_cpp talker

export RMW_IMPLEMENTATION=rmw_zenoh_cpp
ros2 run demo_nodes_cpp listener
```

切换 RMW 后记得重启一次 daemon（`ros2 daemon stop`），否则 `ros2 node list` 这类 CLI 拿到的还是旧 RMW 的图信息。

有几个实际使用中一定会碰到的点：

**默认关闭多播发现。** rmw_zenoh 的默认 session 配置里，多播 scouting 是关的，节点靠 router 的 gossip 拿到对端信息。也就是说，不启动 router 时，同一台机器上的两个节点也互相发现不了。想脱离 router 直连，得显式打开：

```bash
export ZENOH_ROUTER_CHECK_ATTEMPTS=-1
export ZENOH_CONFIG_OVERRIDE='scouting/multicast/enabled=true'
```

**跨主机要在 router 配置里写对端。** 默认配置只在本机发现，跨机器需要改 router 的 `connect/endpoints`，或者在启动时覆盖：

```bash
export ZENOH_CONFIG_OVERRIDE='connect/endpoints=["tcp/192.168.1.1:7447"]'
ros2 run rmw_zenoh_cpp rmw_zenohd
```

**常用环境变量。**

| 变量 | 作用 |
|---|---|
| `ZENOH_ROUTER_CHECK_ATTEMPTS` | 0 无限等 router；<0 跳过检查；>0 重试次数（默认 1） |
| `ZENOH_SESSION_CONFIG_URI` | 节点 session 的自定义配置路径 |
| `ZENOH_ROUTER_CONFIG_URI` | router 的自定义配置路径 |
| `ZENOH_CONFIG_OVERRIDE` | 用 `key=value;key=value` 形式临时覆盖配置 |

**共享内存。** 打开 `transport/shared_memory/enabled=true` 后，Zenoh 会对超过阈值（默认 512 字节）的消息走 SHM，默认池大小 48 MiB。这和 DDS 的共享内存传输思路一致，但实现路径不同：Zenoh 是「隐式 SHM」，应用不需要用 loaned message API。

**互操作边界要提前知道。** rmw_zenoh 与 `zenoh-bridge-ros2dds` 的 key expression 设计不同，两者不能直接互通；Humble 和新版本之间也不兼容，因为从 Iron 开始 type hash 被编进了 key expression。做迁移方案时，这两条会直接决定架构。

生态现状是：**Kilted 起 rmw_zenoh 是官方支持的 RMW，并且已经回移到 Jazzy 和 Humble**。这让它在短时间内从「实验特性」变成了可选项。

## 2. 去中心化通信是怎么完成的

### 2.1 通信模式：从 Topic 到 Key Expression

DDS 的模型里其实没有「发送方 → 接收方」这条线，只有 topic 和两侧各自的声明。发布端声明「我写 /battery/state，类型 sensor_msgs/BatteryState，QoS reliable」，订阅端声明同一套东西，配对交给 DDS 自己完成。在配对成功之前，两边互不知情，一条数据都发不出去；配对失败也不报错，就是安静地什么都不发生。

这是 ROS 2 里最常见的一类问题：topic 名一模一样，`ros2 topic echo` 也能看到数据，自己的回调却不触发。原因通常是三样东西没同时对上——topic 名、type name、QoS 兼容性。QoS 这一项最隐蔽：名字和类型都一致，reliable 的订阅者撞上 best_effort 的发布者，照样收不到，日志里还看不出异常。

ROS 2 的 service 和 action 也不是 DDS 的原生概念，是拿 topic 拼出来的。service 是一对 request/reply topic，用请求 ID 关联；action 是三个 service（send_goal、get_result、cancel_goal）加 feedback、status 两个 topic。所以 service 的发现、QoS、延迟，跟普通 topic 走的是同一套东西。

Zenoh 换了个思路：不比对类型，只比对路径。发布者往 `robot/battery/state` 上写，订阅者写 `robot/**` 就能收到；写成 `robot/*` 就收不到，因为 `*` 只吃一层，而这条路径有三层。规则本身不复杂，但「层级数对不上」这种错很难第一眼看出来，表现同样是安静地收不到。

query/queryable 是另一组原语，功能上对应 service：client 发一个 query，所有 key 匹配的 queryable 都能应答，还能收到多个回复。比 ROS 2 的 service 灵活，代价是「一问一答」得调用方自己保证，协议层不管这个。

两个协议都会静默失败，只是失败的位置不一样：DDS 栽在元数据，Zenoh 栽在路径层级。排查的时候方向是反的。

![两种匹配方式，两种静默失败](fig-04-pattern.png)

*图 4：同样是「收不到」，DDS 是 QoS 对不上，Zenoh 是通配符少匹配了一层*

### 2.2 建链：发现比传输更难

真正让去中心化协议复杂起来的不是数据面，而是控制面——「怎么找到对方」。

#### 2.2.1 DDS：SPDP 多播找人，SEDP 单播配对

DDS 的发现分两步，对应两个内置协议：

1. **SPDP（Simple Participant Discovery Protocol）**：每个 Participant 周期性往多播地址 `239.255.0.1` 的 `7400 + 250 × domainId` 端口发一条宣告，里面带自己的 GUID prefix 和内置端点列表。
2. **SEDP（Simple Endpoint Discovery Protocol）**：知道对方存在之后，通过内置的可靠 writer/reader 交换 `DCPSPublication` / `DCPSSubscription` 数据，内容是 topic 名、type name 和 QoS。

![DDS 发现流程](fig-05-dds-discovery.png)

*图 5：SPDP 负责「发现有人」，SEDP 负责「交换端点信息」，最后按 type + topic + QoS 匹配*

匹配成功要同时满足三个条件：topic 名一致、type name 一致、QoS 兼容（比如 reliable 的 reader 不会跟 best_effort 的 writer 配对）。这也是 ROS 2 里「明明 topic 一样却收不到数据」最常见的原因。

代价在于**发现是周期性的广播**：每个新参与者都要重复一遍，多播跨不了路由器，节点多了以后每个参与者都要处理 N-1 个对端的状态。多播不可达时，很多实现会退化成逐对单播，发现流量随节点数平方增长。缓解方案是 Fast DDS 的 Discovery Server，把多播换成集中式的发现服务——但这就引入了一个「中心」，和「去中心」的初衷有点矛盾。

#### 2.2.2 Zenoh：Scouting、会话握手与声明式路由

Zenoh 把「发现」拆得更细：

1. **Scouting**：想找对端时，向多播地址 `224.0.0.224:7446` 发 SCOUT，收到的实体用 HELLO 单播回应，带上自己的 ZID 和可用 locator。
2. **会话握手**：确定地址后建立链路（TCP/UDP/QUIC/TLS 都行），然后走四步握手：

   - INIT SYN：发起方提出协议版本、ZID、序号分辨率、batch size；
   - INIT ACK：响应方接受参数，并下发一个 16 字节 cookie；
   - OPEN SYN：发起方回传 cookie，提出 lease 和初始序号；
   - OPEN ACK：会话激活。

3. **声明式路由**：会话建立后，订阅者/queryable 通过 DECLARE 声明自己关心哪些 key expression，路由表按「key expression 交集」转发，而不是按固定 topic 名。

![Zenoh 建链流程](fig-06-zenoh-session.png)

*图 6：Scouting 之后是 4 条消息的握手，声明只在变化时发一次*

这个设计的关键差异在于：**发现不是周期性广播，而是按需 + 声明驱动**。节点加入时做一次 scouting，之后靠声明维护路由表；router 之间的 gossip 负责把拓扑变化扩散开。

拓扑也因此更灵活：小规模可以直接 peer 全连接，大规模用 router 组成树或图；远端节点（比如另一台机器上的 RViz）可以切成 client 模式，只连 router，不参与全连接。

### 2.3 报文格式：两种线格式的取舍

再往下看一层，两边的报文结构差异很明显。

**RTPS** 是「固定头 + 子消息」的结构：20 字节固定头（magic `RTPS` 4B、版本 2B、vendorId 2B、GUID prefix 12B），后面跟一串子消息。每个子消息有自己的 4 字节头（id、flags、长度），然后是 body。可靠性靠 HEARTBEAT / ACKNACK 重传，丢包的洞用 GAP 补齐。

**Zenoh** 是「帧 + 批」的结构：流式链路（TCP/TLS/QUIC）上先来 2 字节小端长度，再跟一个 Batch；Batch 里可以塞多条消息。数据走 FRAME（0x05）容器，里面带序号和可靠性标记（R=1 可靠通道，R=0 尽力而为通道），再是 PUSH/REQUEST/RESPONSE 这些网络消息。

![两种线格式](fig-07-wire-format.png)

*图 7：RTPS 每个 sample 独立成子消息；Zenoh 可以把多条消息批量塞进一个 FRAME*

两者对头部开销的取舍不同：

- RTPS 的子消息头固定 4 字节，加上 inline QoS 一般每个 sample 还要几十字节，小消息场景下固定开销占比很高；换来的好处是每条消息自带完整元数据，接收端可以独立解析。
- Zenoh 把多条消息合成一个 Batch 发送，摊薄了系统调用和帧头开销；代价是接收端要先解包，且 batch size 在握手时就定死了上限（默认 65535 字节）。

## 3. 理论性能分析

### 3.1 延迟模型

端到端延迟可以拆成：

```
t = t_discovery + t_serialize + t_queue + t_network + t_deserialize + t_schedule
```

- `t_discovery` 只在建链阶段存在，之后是常数。
- `t_serialize` / `t_deserialize` 取决于类型大小和实现，CDR 与 Zenoh 的编码开销接近。
- `t_queue` 在可靠传输下受重传和流量控制影响，高负载时差异会放大。
- `t_network` 由链路决定，同机走 SHM 时接近内存拷贝，跨网时就是一个 RTT。

同机场景下，DDS 的共享内存 + 零拷贝路径非常短；Zenoh 的 SHM 也能做到近似效果，但多了一层「判断是否走 SHM」的逻辑，小消息反而不占便宜（默认阈值 512 字节就是这个原因）。

### 3.2 吞吐与批处理

吞吐上限大致是：

```
throughput ≈ bandwidth / (payload + header) × batch_efficiency
```

DDS 每个 sample 基本是一个 UDP 包（大消息用 DATA_FRAG 分片），单包有效载荷受 MTU 限制，头部开销按比例摊。Zenoh 的批处理可以把多个小消息合成一次发送，在小消息高频场景下更有优势；但 TCP 的拥塞控制会引入额外延迟，所以 Zenoh 提供了 low-latency 模式（跳过 FRAME 批处理，直接发网络消息）。

### 3.3 发现开销：平方 vs 线性

把发现开销单独拎出来看，差距最直观。假设每轮每个节点都要宣告一次：

- DDS：多播可用时每轮发 N 个多播包，但**每个节点都要处理 N-1 个对端声明**；多播不可达退化成逐对单播后，网络上的报文数变成 N(N-1)。
- Zenoh：节点只跟 router 建会话，每轮约 N 条，声明变化才发。

![拓扑与发现开销](fig-08-topology.png)

*图 8：左图是全连接与星型的拓扑对比，右图是多播不可用、退化为单播时的发现报文数模型*

这也解释了一个常见现象：小规模、单机、多播正常的时候，DDS 的发现开销几乎无感；一旦节点数上到几十个，或者网络不支持多播，发现就会成为主要开销。

### 3.4 预期结论与实测计划

在写这段之前，我特意没有给出「参数对比表」，因为不同实验条件下的结论差别很大。能站得住的判断大概是：

- **同机、小规模、实时性优先**：DDS 的共享内存路径更短，延迟更低，生态也更成熟。
- **跨网、大规模、拓扑动态**：Zenoh 的发现开销和跨网能力优势明显。
- **迁移成本**：RMW 抽象让切换代码成本很低，但 QoS 语义差异、工具链、以及 rmw_zenoh 与 DDS 无法直接互通，都是真实成本。

公开资料里有一组常被引用的数据：多机器人场景下 Zenoh 的发现开销降低了 97–99%，可达性提升，延迟降低约 70%。这类数字很吸引人，但实验规模、网络条件、是否开 SHM 都会显著影响结果，引用时最好带上条件。

后续计划是补一组实测：固定节点数和消息大小，分别用 `rmw_fastrtps_cpp` 和 `rmw_zenoh_cpp` 跑 `ros2 topic hz` / `ros2 topic bw`，同时用 Wireshark 抓两种报文对比字节数。到那时再给结论。

## 4. 小结

DDS 和 Zenoh 不是「新替旧」的关系，而是两种不同的去中心化思路：

- DDS 把「类型 + QoS」当作契约，靠多播发现建立全连接，适合局域网内确定性的实时系统；
- Zenoh 把「key 空间」当作契约，靠路由器和声明建立按需连接，适合跨网、大规模、动态拓扑的场景。

rmw 抽象让二者可以在同一个 ROS 2 应用里切换，但真正的成本不在代码，而在 QoS 语义、调试工具和互操作边界。选型时先问清楚网络条件，比比较 benchmark 数字更有用。

## 参考

- [Eclipse Zenoh 协议规范](https://spec.zenoh.io/)：会话建立、帧格式、路由与 key expression 的权威定义
- [rmw_zenoh README](https://github.com/ros2/rmw_zenoh)：配置项、SHM、已知问题与互操作说明
- [DDSI-RTPS 规范](https://www.omg.org/spec/DDSI-RTPS/)：SPDP/SEDP 与 RTPS 报文的正式定义
- [Zenoh 路由章节](https://spec.zenoh.io/spec/1.0.0/architecture/routing.html)：基于 key expression 交集的路由决策
