# 皮肤动画状态映射设计（hwdc 桌宠动画状态机）

> 状态：设计文档（本轮不实现）
> 范围：`desktop-pet/web/pet.js` 动画状态机 + 皮肤 layout 适配
> 参照实现：OC-Claw（rainnoon/oc-claw，MIT，Tauri v2 + React + TS）
> 代码证据基于本仓库 `feat/tray-host` 分支；凡需实机确认之处标注 **待实测（winpc）**。

---

## 1. 现状与问题

### 1.1 数据链路

```
Hermes WebUI 页面内 extension（companion-adapter.js）
  └─ buildAttention() → status ∈ {action_required, running, ready}，优先级 3>2>1
        （extension/companion-adapter.js:696-761）
  └─ postSnapshot() → POST /api/webui/snapshot（poll / heartbeat / load / unload）
        （extension/companion-adapter.js:1045-1101）
loopback sidecar（loopback-server.mjs）
  └─ latestAttention()：仅当 snapshot 为 'fresh' 才返回 sessions，否则返回 []
        TTL = 30s（PET_SNAPSHOT_ATTENTION_TTL_MS，loopback-server.mjs:23, 280-312）
pet.js
  └─ refresh() 每 1s 拉 /api/pet/attention（pet.js:260-267）
  └─ render() 状态映射（pet.js:256）：
        action_required → waiting
        ready          → waving
        running        → running
        无             → idle
```

### 1.2 现有状态机构成（pet.js）

| 环节 | 位置 | 行为 | 备注 |
|---|---|---|---|
| 状态定义 | `DEFAULT_PET_LAYOUT`（pet.js:25） | 9 态：idle / running-right / running-left / waving / jumping / failed / waiting / running / review | 与 Codex hatch-pet 8×9 行约定一致 |
| 布局校验 | `_normalizeSkinLayout`（pet.js:97-105） | 要求 9 态**名称齐全**，缺任一 → 整体回退 DEFAULT_PET_LAYOUT | 现实数据下几乎恒通过（见 1.4） |
| 状态切换 | `_setState`（pet.js:216） | 目标态不在 layout.states → 强制回 'idle'；切换时 frame=0 | 回退分支在 9 态恒全时是死代码 |
| 帧推进 | `_tick`（pet.js:217）+ `setInterval(FRAME_MS=520)` | 全状态统一 520ms/帧（≈1.92fps） | 无 per-state fps |
| 注意力映射 | `render()`（pet.js:256） | 见 1.1；`!_isDragging` 时才写状态 | |
| 拖拽方向 | `_emitPetLayout`（pet.js:402） | 拖拽中按 dx 切 running-right / running-left | 拖拽结束 `_stopDragLayoutTracking`→`render()` 恢复 |
| 点击 | `_onStageClick`（pet.js:524/528） | stage 点击 → jumping + 打开 WebUI | badge 点击（518-522）只折叠气泡，**不触发动画** |
| 皮肤加载 | `_applyPetSkin`（pet.js:142-161） | 切背景图 + 尺寸，未重算当前状态合法性 | |
| 数据源空 | loopback-server.mjs:289 | snapshot 非 fresh → sessions=[] | |

### 1.3 用户反馈："皮肤动画一直是待机动画"

#### 候选失效点 A：attention 数据源为空 → 永远 idle（★ 最可能）

- snapshot 由 **WebUI 页面内的 extension** 推送（companion-adapter.js:1071-1101）；TTL 仅 30s（loopback-server.mjs:23, 284）。
- 桌宠常驻时若 WebUI 页面未打开 / extension 未注入 / 页面已 unload（unload 快照 reason='unloaded'）→ `latestAttention` 返回 `[]` → `render()` 恒置 idle。
- 前端对"attention 为空"与"确实无任务"**无法区分**，也无任何降级提示。
- **待实测（winpc）**：仅开桌宠、不开 WebUI 页面时，`/api/pet/attention` 返回的 `sessions` 是否恒为空。

#### 候选失效点 B：状态切换视觉差异过小（★ 强候选，叠加 A）

- 全部 9 态共用 `FRAME_MS=520`（≈1.92fps），无 per-state 帧率差异；对比 OC-Claw 每状态独立 fps（idle=2、running=6、waiting=6、jumping=6、run-left/right=8，codexPet.ts:58-65）。
- idle（6 帧）与 running（6 帧）同帧率同节奏；若皮肤图集这两行动作相近，切换几乎无感知。
- **待实测（winpc）**：任务运行中（extension 正常推送）观察桌宠是否切到 running/waving。

#### 候选失效点 C：瞬态动画无 one-shot 语义，被轮询覆盖

- jumping 触发后**循环播放**，下一轮 `refresh()`（1s）的 `render()` 立即按 attention 覆盖回 idle/waiting/...（pet.js:256, 598）→ 跳跃实际可见时长 ≤1s，且无"播完冻结最后一帧"的节奏。
- OC-Claw 有完整 one-shot 机制：`ONE_SHOT_STATES={jumping}`、播完冻结末帧、`onOneShotEnd` 回调、`JUMP_REST_MS=400` 后重播（SpritePet.tsx:31, 96-108；MiniPetMascot.tsx:37, 92-101）。

#### 候选失效点 D：状态抖动导致帧反复重置

- `_setState` 在状态变化时 `frame=0`（pet.js:216）；若 attention 状态在轮询间抖动（如 ready↔idle），动画每 1s 回到第一帧，看起来"卡住/不动"。
- **待实测（winpc）**：任务接近完成/完成瞬间观察动画是否"卡帧"。

#### 候选失效点 E：皮肤缺态兼容性（结构性，非本次问题根因）

- `_normalizeSkinLayout` 9 态齐全校验导致：**任何只声明部分状态的皮肤被整体回退 DEFAULT**，其声明的行布局完全失效。
- 而现实数据源（loopback-server.mjs:674-697 `petLayoutForDimensions`）总是按图集尺寸推断出标准 9 态 → 校验恒通过，回退分支实际不触发。
- 影响在未来：若支持 OC-Claw 生态式"约定行布局"或声明子集的皮肤包，现状会静默用错布局。

#### 候选失效点 F：交互反馈弱

- badge 点击只折叠/展开气泡（pet.js:499-510, 518-522），无动画反馈；jumping 只在 stage 点击触发。
- 无 `prefers-reduced-motion` 适配（OC-Claw 亦无；生态参考中 ChatGPT 桌面端有：跟随系统 reduced-motion 切静态帧）。

### 1.4 与 OC-Claw 布局模型的差异

- OC-Claw：`pet.json` **不声明行布局**，`ANIMATION_ROWS` 硬编码 9 行"约定"（codexPet.ts:39-49），宠物图集必须符合约定，无皮肤级 fallback；hwdc 若遇到不符合约定的图集（如 4 行 legacy），有 `LEGACY_PET_ROW_BY_STATE` 兜底（loopback-server.mjs:45-55）。
- hwdc：布局由尺寸推断 + 前端 9 态校验双保险，理论上更稳；**问题不在布局层，而在状态源与视觉节奏层**（A/B/C）。

---

## 2. OC-Claw 调研对照表

调研对象：`frontend/src/Mini.tsx`、`components/SpritePet.tsx`、`components/MiniPetMascot.tsx`、`lib/codexPet.ts`（/tmp/oc-claw，clone 自 rainoon/oc-claw）。

### 2.1 状态来源与优先级

| 维度 | OC-Claw | hwdc（现状） | 差异结论 |
|---|---|---|---|
| 源状态集 | `PetState = idle \| working \| compacting \| waiting`（Mini.tsx:116） | attention: `action_required \| ready \| running \| 无` | OC-Claw 语义更粗（working 合并 running），hwdc 细分 ready/action_required |
| 状态判定 | `claudeWaiting = sessions.some(status==='waiting')`；`claudeCompacting`；`claudeWorking = processing \|\| tool_running`；`hasWorking = anySessionActive \|\| healthMap \|\| claudeWorking \|\| claudeCompacting \|\| claudeWaiting`（Mini.tsx:4011-4014） | `items.some(action_required) / some(ready) / some(running)`（pet.js:256） | OC-Claw 多路探活（会话 + agent 健康 + 本地 CLI），hwdc 单一 attention 快照 |
| **优先级** | `waiting > compacting > working > idle`（Mini.tsx:4016，注释明确） | `action_required(3) > running(2) > ready(1)`（companion-adapter.js:713 排序），渲染侧 `waiting > waving > running > idle`（pet.js:256） | 一致：**等待类最高**；差异：hwdc 的 ready 最低，OC-Claw 无 ready 概念 |
| 源→精灵映射 | `petStateToCodexState`：working/compacting→running，waiting→waiting，idle→idle（codexPet.ts:107-119） | action_required→waiting，ready→waving，running→running，无→idle | hwdc 用 waving 表达 ready（"召唤关注"），语义合理；OC-Claw 无 waving 用途说明 |
| **移动叠加** | `walkDir===1 → run-right，-1 → run-left`，**覆盖 resting 状态**（Mini.tsx:4020-4024） | 拖拽中 `dx 变化 >2px → running-right/left`（pet.js:402） | 机制一致：移动方向态 > attention 态 |
| **hover 叠加** | `showJump → 'jumping'` 覆盖 baseState；拖动中 `suppressHover` 防止 jumping 掩盖 run-left/right（MiniPetMascot.tsx:68-71, 117） | 无 hover 动画 | OC-Claw 有交互层级：hover > walkDir > attention |
| 状态广播 | `mini-pet-state` 事件 + 2s heartbeat（Mini.tsx:4050-4060），DemoMascot 只镜像不派生 | `pet-attention-update` 事件（pet.js:474-478） | 类似 |

### 2.2 渲染与节奏

| 维度 | OC-Claw | hwdc（现状） | 差异结论 |
|---|---|---|---|
| 帧率 | 全局 `SPRITE_FPS=12` + per-state 覆盖 `STATE_FPS`：idle=2、jumping=6、running=6、waiting=6、run-left/right=8（codexPet.ts:51-69） | 全局 `FRAME_MS=520`（≈1.92fps）统一（pet.js:12, 217） | **hwdc 无节奏差异** → 状态切换感知弱（失效点 B） |
| 循环间停顿 | `STATE_LOOP_REST_MS: waiting=600ms`，循环末帧冻结后再播（codexPet.ts:76-82；SpritePet.tsx:109-118） | 无 | hwdc 可借鉴：waiting/waving 加"爆发-停顿"节奏 |
| one-shot | `ONE_SHOT_STATES={jumping}`：播完冻结末帧 + `onOneShotEnd` + 400ms 后重播（SpritePet.tsx:31, 96-108；MiniPetMascot.tsx:37, 92-101） | jumping 循环播放，≤1s 被 render 覆盖 | **hwdc 缺 one-shot 语义**（失效点 C） |
| 帧推进 | requestAnimationFrame + 时间累积（SpritePet.tsx:58-129） | setInterval 520ms（pet.js:597） | 等效可用；hwdc 可保留 setInterval 但支持 per-state 帧间隔 |
| 缺态 fallback | **无**（图集必须符合 8×9 约定；codexPet.ts:39-49 硬编码） | `_setState` 缺态→idle；layout 缺态→整体回退 DEFAULT（pet.js:103, 216） | hwdc 更宽容；但"整体回退"粒度粗，见 §3.3 |
| reduced-motion | 无处理 | 无处理 | 两者皆缺，hwdc 新设计应补上 |

### 2.3 可借鉴结论（一句话）

> OC-Claw 用 **waiting 最高优先级的粗粒度源状态** + **walkDir/hover 两层叠加** + **per-state 帧率/停顿/one-shot 渲染节奏** 让"角色在干什么"一眼可辨；hwdc 缺的是**渲染节奏差异化**与**瞬态动画语义**，以及 attention 数据源为空时的**可诊断性**。

---

## 3. 统一状态模型设计

### 3.1 状态源（State Source）

统一为两层：**注意力状态（attention，慢变）** + **交互状态（interaction，瞬态/高优先）**。

```
交互状态（瞬态，优先覆盖 attention）
  dragging       → running-right / running-left（拖拽期间持续，按 dx 切换）
  stage click    → jumping（one-shot，播完冻结末帧 400ms，期间不受 attention 覆盖）
  badge click    → （保持现状：仅折叠气泡；可选用 waving 一次性反馈）

注意力状态（慢变，每 1s refresh 重算）
  items 含 action_required → waiting
  items 含 ready           → waving
  items 含 running         → running
  无                        → idle

叠加顺序（优先级从高到低）：
  dragging 方向 > jumping(驻留期内) > attention 状态 > idle
```

- 优先级与 OC-Claw 对齐：**waiting 类最高**（action_required→waiting 现有映射保留）。
- jumping 驻留锁：one-shot 播放 + 冻结期间，`render()` 不得覆盖；冻结结束（400ms）后回到 attention 状态。实现建议：`transientUntil` 时间戳，`_setState` 与 `render()` 均检查。
- 拖拽方向：`_isDragging` 期间 render 不写状态（现状已如此，pet.js:256），保持。

### 3.2 优先级与驻留时长（Dwell Time）

| 状态 | 优先级 | 驻留行为 | 帧率建议 | 循环间停顿 |
|---|---|---|---|---|
| running-left / running-right | 1（交互） | 拖拽期间常驻；结束后回 attention 态 | 8fps（≈125ms/帧） | 无 |
| jumping | 1（交互，one-shot） | 5 帧播完冻结末帧 400ms，驻留锁内不被覆盖；之后回 attention 态 | 6fps | 无（冻结即停顿） |
| waiting | 2（attention，最高） | 常驻直至 refresh 改变；建议最小驻留 1.5s 防抖动 | 4-6fps | 600ms（借鉴 OC-Claw） |
| waving | 2（attention） | 常驻（ready 持续则持续挥手）；最小驻留同上 | 4-6fps | 600ms |
| running | 2（attention） | 常驻；最小驻留同上 | 6fps | 无 |
| idle | 3（缺省） | 常驻 | 2fps（慢呼吸，借鉴 OC-Claw） | 无 |

- **最小驻留（anti-flutter）**：attention 状态切换后至少驻留 1.5s（>1s 轮询周期），期间即使 refresh 结果变化也不切态；解决失效点 D 的帧重置抖动。实现建议：`attentionStateSince` 时间戳 + `_setState` 内判断。
- 帧率实现建议：保留 `setInterval(_tick, FRAME_MS)` 心跳，`_tick` 内按 `FRAME_MS_FOR_STATE[state]` 的倍率累加跳过（如 idle 每 2 心跳推进 1 帧），避免引入 rAF 重构。

### 3.3 皮肤 layout 缺态 fallback 表（替代"整体回退 DEFAULT"）

保留 `_normalizeSkinLayout` 的 9 态齐全校验作为**布局合法性判定**（不合法仍回退 DEFAULT，保证帧坐标正确）；但 **`_setState` 的状态解析层**改为按语义 fallback，使"声明子集"的皮肤也能部分生效：

| 目标状态 | fallback 链（按语义相近度） |
|---|---|
| idle | `idle` → 无 → 第一个可用态 |
| running | `running` → `idle` → 第一个可用态 |
| running-right | `running-right` → `running` → `idle` |
| running-left | `running-left` → `running` → `idle` |
| waving | `waving` → `idle` → 第一个可用态 |
| jumping | `jumping` → `idle` → 第一个可用态 |
| waiting | `waiting` → `idle` → 第一个可用态 |
| failed | `failed` → `idle` → 第一个可用态 |
| review | `review` → `idle` → 第一个可用态 |

实现建议：新增 `_resolveStateName(layout, target)`（纯函数，返回 layout 中存在的最优状态名），`_setState` 与 `render()` 全部改经它解析；`_normalizeSkinLayout` 保持不变。

### 3.4 prefers-reduced-motion → 静态帧

- 启动时 `matchMedia('(prefers-reduced-motion: reduce)')` 检测（可监听 `change`）。
- 命中时：渲染 idle 第 0 帧（或当前 attention 状态第 0 帧），`_tick` 停表；交互瞬态（拖拽/jumping）也不播放。
- 行为对齐生态参考（ChatGPT 桌面端宠物：跟随系统 reduced-motion 切静态帧）。

### 3.5 切皮肤时状态重校验

- `_applyPetSkin`（pet.js:142-161）末尾增加：`_setState(state)`（经 `_resolveStateName` 解析），保证当前状态在新 layout 下合法、frame 从 0 重播；避免换皮后状态名失效卡在旧帧。
- 皮肤切换事件（`pet-skin-change` / storage / 轮询）均走 `_applyPetSkin`，一处覆盖。

### 3.6 可诊断性（针对失效点 A）

- `refresh()` 失败或 attention 为空时，与"确实无任务"不可区分 → 建议后续在 `source` 字段（loopback-server.mjs:1687 已透传 empty/unloaded/stale/fresh）基础上，于页面或日志暴露当前数据源状态（如 debug 输出 `attention source=stale`）。
- 本设计文档不要求前端 UI 改动；仅记录为实施阶段可选项。

---

## 4. 实施阶段任务拆分（留待后续轮次）

> 每阶段独立可验证、可回退；只改 `desktop-pet/web/pet.js`（含可能的配套文件），不涉及 Rust/后端。

### 阶段 1：状态解析层重构
- 新增 `_resolveStateName(layout, target)` + fallback 表（§3.3）；`_setState`、`render()` 改经解析。
- 保留 `_normalizeSkinLayout` 9 态校验不变。
- **验证点**：构造缺态 layout 的皮肤（本地 web 环境注入），确认：a) 9 态皮肤行为与现状完全一致（回归）；b) 缺态皮肤不再整体回退，缺态时按 fallback 链落到可用态；c) `_applyPetSkin` 后当前状态重校验生效。

### 阶段 2：瞬态动画语义
- jumping 改 one-shot：播完冻结末帧 + 400ms 驻留锁（`transientUntil`），锁内 render 不覆盖；stage click 后可见完整跳跃。
- 拖拽方向态在拖拽期间不被 attention 覆盖（现状已具备，补回归测试路径）。
- **验证点**：点击 stage 看到完整 5 帧跳跃 + 末帧停顿；拖拽时看到 running-left/right；**待实测（winpc）**：真实窗口拖拽下动画与方向一致、无跳帧。

### 阶段 3：渲染节奏差异化
- 引入 `FRAME_MS_FOR_STATE`（§3.2 建议值）+ `_tick` 倍率累加；waiting/waving 加 600ms 循环间停顿（借鉴 OC-Claw `STATE_LOOP_REST_MS`）。
- **验证点**：idle 呈慢呼吸、running 节奏加快、waiting 呈"爆发-停顿"；状态切换肉眼可辨（对应失效点 B）。**待实测（winpc）**：任务运行/等待时桌宠动画可区分。

### 阶段 4：attention 状态最小驻留（anti-flutter）
- attention 状态切换后 ≥1.5s 内不切态（`attentionStateSince`）。
- **验证点**：人为抖动 attention 返回值（本地 mock），确认动画不卡帧（对应失效点 D）。

### 阶段 5：prefers-reduced-motion
- `matchMedia` 检测 + 静态帧 + 停表；监听 `change` 动态恢复。
- **验证点**：系统开启"减少动态效果"后桌宠静止于 idle 首帧；关闭后恢复动画。

### 阶段 6（可选）：数据源可诊断性
- 利用 `/api/pet/attention` 的 `source` 字段，在 pet 窗口 console/debug 输出 `empty/unloaded/stale` 原因；或后续接入 UI 提示"WebUI 未连接，无任务状态"。
- **验证点**：不开 WebUI 页面时能看到明确诊断（对应失效点 A）。

---

## 5. 附录：关键代码索引

| 文件 | 行号 | 内容 |
|---|---|---|
| desktop-pet/web/pet.js | 25 | DEFAULT_PET_LAYOUT 9 态定义 |
| desktop-pet/web/pet.js | 97-105 | _normalizeSkinLayout 9 态齐全校验 |
| desktop-pet/web/pet.js | 142-161 | _applyPetSkin（切皮无状态重校验） |
| desktop-pet/web/pet.js | 213-217 | _stateSpec / _frameCount / _applyFrame / _setState / _tick |
| desktop-pet/web/pet.js | 256 | render() 状态映射（waiting/waving/running/idle） |
| desktop-pet/web/pet.js | 402 | 拖拽方向 → running-left/right |
| desktop-pet/web/pet.js | 518-528 | badge 点击（折叠）/ stage 点击（jumping） |
| desktop-pet/web/bubbles.js | 24 | DEFAULT_PET_LAYOUT（同 9 态，需同步演进） |
| extension/companion-adapter.js | 696-761 | buildAttention：action_required/running/ready 生成 |
| extension/companion-adapter.js | 1045-1101 | snapshot 推送（poll/heartbeat/unload） |
| src/loopback-server.mjs | 23, 280-312 | attention TTL=30s；latestAttention 仅 fresh 返回 |
| src/loopback-server.mjs | 674-697 | petLayoutForDimensions：按尺寸推断 9 态布局 |
| /tmp/oc-claw/.../lib/codexPet.ts | 39-82 | ANIMATION_ROWS / STATE_FPS / STATE_LOOP_REST_MS |
| /tmp/oc-claw/.../components/SpritePet.tsx | 31, 96-118 | one-shot + 循环间停顿 |
| /tmp/oc-claw/.../components/MiniPetMascot.tsx | 68-71, 92-117 | hover 叠加 / suppressHover / 跳跃重播 |
| /tmp/oc-claw/.../Mini.tsx | 4011-4024 | 状态优先级 + walkDir 叠加 |
