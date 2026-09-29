# MPD 播控音箱 — 插件间通信 API

## 概述

MPD 播控音箱插件（entryPath: `mpd-player`）通过 `songloft.comm` 暴露播放控制接口，其他插件可以调用这些接口控制 MPD 播放器的播放、队列、音量等。

## 前置条件

调用方插件需要在 `plugin.json` 中声明权限：

```json
{
  "permissions": ["inter-plugin"]
}
```

## 调用方式

以下插件间通信 API 使用 `songloft.comm.call(entryPath, action, payload, timeout)` 调用：

```typescript
var result = await songloft.comm.call("mpd-player", "action-name", { ... }, 5000);
```

## 返回值格式

所有 API 统一由 `commHandler` 包装器处理返回值：

```typescript
{
  success: true | false,    // 是否成功
  data?: any,               // 返回数据（查询类 API 有）
  error?: string            // 错误信息（仅 success=false 时有）
}
```

### 重要：不要重复包装返回值

MPD 插件内部的 `commHandler` 会自动包装返回值，**不要**在 handler 中手动包装 `{ success: true, data: ... }`。

**错误示例（MPD 插件内部）：**
```typescript
const state = await getPlayerState(songloft);
return { success: true, data: state };  // ❌ commHandler 会再包一层
```

**调用方拿到的是双层包装：**
```typescript
const result = await songloft.comm.call("mpd-player", "status", {}, 5000);
const status = result.data;           // { success: true, data: {...} } — 不是期望的数据
const outputMode = status.outputMode; // undefined
```

**正确做法（MPD 插件内部）：**
```typescript
return await opStatus(songloft);  // ✅ 直接返回裸数据，commHandler 自动包装
```

**调用方正确取值：**
```typescript
const result = await songloft.comm.call("mpd-player", "status", {}, 5000);
if (result.success && result.data) {
  const status = result.data;           // ✅ 直接使用 result.data
  const outputMode = status.outputMode;  // ✅ "mpd"
}
```

### 排查双层包装

如果调用 `status` 或 `get-queue` 后发现 `result.data` 结构不对，检查：
1. MPD 插件内的 comm handler 是否有手动包装返回值
2. `JSON.stringify(result.data)` 查看真实结构

## API 参考

### 播放控制

| Action | 参数 | 说明 |
|--------|------|------|
| `play` | `{ songId: number }` | 立即播放指定歌曲（需 songId 来自 Songloft 歌曲库） |
| `play-url` | `{ url: string, title?: string, artist?: string, album?: string, cover_url?: string, duration?: number }` | 把在线音频 URL **追加到队列末尾并播放**（不经过歌曲库，**不会清空原队列**） |
| `pause` | `{}` | 暂停播放（正在播放时生效） |
| `resume` | `{}` | 恢复播放（已暂停时生效） |
| `toggle` | `{}` | 切换播放/暂停 |
| `prev` | `{}` | 上一首 |
| `next` | `{}` | 下一首 |
| `seek` | `{ seconds: number }` | 跳转到指定时间点 |
| `volume` | `{ volume: number }` | 设置音量 0-100 |

### 队列管理

| Action | 参数 | 说明 |
|--------|------|------|
| `queue-replace` | `{ songIds: number[] }` | 清空队列并添加新歌曲 |
| `queue-append` | `{ songIds?: number[], urls?: Array<string \| { url: string; title?: string; artist?: string; album?: string; cover_url?: string; duration?: number }> }` | 追加歌曲/URL 到队列末尾（可同时传 songIds 和 urls；`urls` 支持纯字符串或携带标题/封面信息的对象，供 DLNA 推送与队列显示使用） |
| `queue-clear` | `{}` | 清空队列 |
| `queue-jump` | `{ position: number }` | 跳转到队列指定位置并播放（1-based） |
| `queue-move` | `{ fromPosition: number, toPosition: number }` | 移动队列中歌曲位置（1-based） |
| `queue-remove` | `{ position: number } 或 { positions: number[] }` | 移除队列中指定位置的歌曲（1-based） |
| `get-queue` | `{}` | 获取完整队列列表 |

### 播放模式

| Action | 参数 | 说明 |
|--------|------|------|
| `set-mode` | `{ random?: boolean, repeat?: boolean, single?: boolean, consume?: boolean }` | 设置播放模式，只传需要修改的项 |

### 状态查询

| Action | 参数 | 说明 |
|--------|------|------|
| `status` | `{}` | 获取当前播放状态（含当前歌曲、进度、音量、播放模式、封面等） |

#### 如何判断播放器是否在线（可播）

不要单独判断"MPD 进程状态"——插件支持 MPD / DLNA 两种输出模式，DLNA 模式下 MPD 进程停止是正常的。正确做法是用 `status` 三步判定：

```typescript
var r = await songloft.comm.call("mpd-player", "status", {}, 5000);
if (!r || !r.success) {
  // 插件未运行或内部出错，不可播
} else if (r.data.outputMode === "mpd") {
  var online = r.data.serviceStatus === "running";   // MPD 后端是否在线
} else if (r.data.outputMode === "dlna") {
  var online = !!r.data.dlnaDevice;                   // 是否已选中 DLNA 设备
}
```

| 层级 | 判据 | 含义 |
|------|------|------|
| 1 | `comm.call` 抛错或 `success=false` | 插件本身不在线 |
| 2 | `data.outputMode` | 当前输出模式：`"mpd"` 或 `"dlna"` |
| 3 | MPD：`serviceStatus === "running"`；DLNA：`dlnaDevice` 非空 | 该模式的播放后端是否就绪 |

#### `currentSong` 字段说明

当有歌曲正在播放时，`data.currentSong` 包含以下字段：

```typescript
{
  songId: string | null;  // 歌曲库 ID，URL 项（play-url）为 null
  title: string;          // 歌曲标题。URL 项从 play-url 传入的 title 回填
  artist: string;         // 歌手。URL 项从 play-url 传入的 artist 回填
  album: string;          // 专辑。URL 项从 play-url 传入的 album 回填
  cover_url?: string;     // 封面图片 URL。库内歌曲："/api/v1/songs/{id}/cover"；
                          // 在线音乐/电台：推送时传入的绝对 CDN URL
}
```

`cover_url` 可直接用于 `<img>` 标签或 `background-image`。相对路径（库内歌曲）需拼接宿主域名，绝对 URL（在线音乐/电台）可直接使用。

#### `lyrics` 字段说明

`data.lyrics` 包含当前歌曲的歌词状态：

```typescript
{
  source: "api" | "library" | "none";  // 歌词来源
  available: boolean;                   // 是否有歌词行
  lines: Array<{ timeSeconds: number; text: string }>;
}
```

- `source: "api"` — 通过 `/api/v1/songs/{id}/lyric` 从宿主获取
- `source: "library"` — 从歌曲库记录中读取（`lyrics`/`lyric`/`lrc` 字段）
- `source: "none"` — 无真实歌词，`lines` 为空数组（不再返回 fallback 假歌词）

## 使用示例

### 有声书插件：播放指定章节

```typescript
// 替换当前队列，播放有声书章节（songId 来自 Songloft 歌曲库）
await songloft.comm.call("mpd-player", "queue-replace", {
  songIds: [101, 102, 103, 104]
});

// 跳转到第 3 章 900 秒处
await songloft.comm.call("mpd-player", "seek", { seconds: 900 });
```

### 在线音乐推送：追加 URL 并播放

```typescript
// 把在线音频追加到当前队列末尾并立即播放，不清空原有队列
await songloft.comm.call("mpd-player", "play-url", {
  url: "https://example.com/audio.mp3",
  title: "播客 episode-1",          // 可选，队列/设备显示用
  artist: "主播",                     // 可选
  cover_url: "https://example.com/c.jpg", // 可选，封面
  duration: 180                      // 可选，秒
});
```

### 播放控制：上下首

```typescript
await songloft.comm.call("mpd-player", "prev", {}, 5000);
await songloft.comm.call("mpd-player", "next", {}, 5000);
```

### 队列管理：追加歌曲和 URL

```typescript
// 同时追加库内歌曲和外部 URL（urls 支持字符串或带元数据的对象）
await songloft.comm.call("mpd-player", "queue-append", {
  songIds: [201, 202],
  urls: [
    "https://example.com/audio.mp3",
    { url: "https://example.com/ep2.mp3", title: "episode-2", artist: "主播", cover_url: "https://example.com/c2.jpg" }
  ]
});
```

### 队列管理：跳转、移动、移除

```typescript
// 跳转到队列第 5 首播放
await songloft.comm.call("mpd-player", "queue-jump", { position: 5 });

// 将第 3 首移动到第 7 首
await songloft.comm.call("mpd-player", "queue-move", { fromPosition: 3, toPosition: 7 });

// 移除第 2 首
await songloft.comm.call("mpd-player", "queue-remove", { position: 2 });

// 批量移除第 1、3、5 首
await songloft.comm.call("mpd-player", "queue-remove", { positions: [1, 3, 5] });
```

### 设置播放模式

```typescript
// 开启随机播放
await songloft.comm.call("mpd-player", "set-mode", { random: true });

// 同时设置 repeat 和 single
await songloft.comm.call("mpd-player", "set-mode", { repeat: true, single: false });
```

### 音乐推送插件：推荐歌曲

```typescript
// 获取当前播放状态
var status = await songloft.comm.call("mpd-player", "status", {}, 5000);

// 如果正在播放，追加推荐歌曲到队列末尾
if (status.data.playbackStatus === "playing") {
  await songloft.comm.call("mpd-player", "queue-append", {
    songIds: [201, 202, 203]
  });
}
```

### 轮询状态示例

```typescript
var lastSongId = null;
setInterval(async function() {
  var status = await songloft.comm.call("mpd-player", "status", {}, 3000);
  if (status.success && status.data.currentSong) {
    if (status.data.currentSong.songId !== lastSongId) {
      console.log("切歌了:", status.data.currentSong.title);
      lastSongId = status.data.currentSong.songId;
    }
  }
}, 5000);
```

## 注意事项

- 所有 API 建议设置 5 秒超时
- `play` 需要传入有效的 `songId`（来自 Songloft 歌曲库，通过 `songloft.songs.list` 或 `songloft.songs.search` 获取）
- `play-url` 支持 MPD 和 DLNA 两种输出模式，语义为**追加到队列末尾并播放该 URL，不清空原队列**；`title`/`artist`/`cover_url`/`duration` 会写入队列元数据，供 `/api/queue`、`status` 的 `currentSong` 与 DLNA 设备显示，建议传入
- `queue-replace` 会清空当前队列，谨慎使用
- `pause`/`resume` 内部会判断当前状态，不会误操作
- `play-url` 的 `title` 和 `artist` 在 MPD 和 DLNA 两种模式下均会显示在 `status.currentSong` 与设备上，建议传入
- `queue-append` 同时支持 `songIds`（库内歌曲）和 `urls`（外部 URL），可单独传或混合传；`urls` 支持纯字符串或 `{url,title?,artist?,album?,cover_url?,duration?}` 对象（对象会写队列元数据）
- `queue-remove` 支持 `position`（单条）和 `positions`（批量），至少传一个
- `queue-jump` 和 `queue-move` 的 position 均为 1-based
- `set-mode` 只修改传入的字段，不传的字段保持当前值不变

## HTTP 音频配置（独立于插件间通信）

FIFO 是 MPD 模式内的音频输出类型，播放器 `outputMode` 仍为 `"mpd"`。下列接口是设置页使用的 HTTP 接口，**不是 `songloft.comm` action**，沿用宿主的认证要求。

- 读取：`GET /api/v1/jsplugin/mpd-player/api/mpd/status`，返回 `data.audioPreferences`。
- 保存：`POST /api/v1/jsplugin/mpd-player/api/mpd/audio/preferences`，`Content-Type: application/json`。

```json
{
  "outputType": "fifo",
  "fifoPath": "/run/snapcast/songloft.fifo",
  "fifoFormat": "44100:16:2",
  "restart": true
}
```

`outputType` 可选 `auto`、`pulse`、`alsa`、`pipewire`、`null`、`fifo`；已有 `xdgRuntimeDir`、`pulseServer`、`pipewireRemote`、`alsaDevice` 字段继续保留。首次未配置 FIFO 字段时默认路径为 `/run/snapcast/songloft.fifo`，格式为 `44100:16:2`；保存时省略字段会保留当前值。显式传入空字符串会保留在界面中，选择 FIFO 后由服务器拒绝，不静默填默认值。

FIFO 路径必须是绝对 POSIX 文件路径，最多 4095 字符，不能包含控制字符、双引号、反斜杠或空/点路径段。PCM 格式为 `rate:bits:channels`，采样率 8000–384000、位深 16/24/32、声道 1/2；不要加前后空白。`restart: true` 会重启插件管理的 MPD；成功响应的 `data` 包含 `preferences`、`restart`、`runtime`、`player`。参数错误或 MPD 未报告 FIFO 支持会返回错误，不自动切到 ALSA/Pulse。

恢复默认设置时发送 `outputType: "auto"`，将桌面音频/ALSA 字段清空，并显式将 FIFO 两项恢复为上述默认值。部署须在 MPD 与 Snapserver 启动前预建 FIFO，保留既有管道 inode；插件本身不管理该管道的创建/删除。共享目录、UID/GID 权限、MPD 创建管道时的清理行为、PCM/FLAC 配置及未实测范围见 [README 的 FIFO / Snapcast 说明](README.md#fifo--snapcastlinux-docker)。

## 附录：Songloft 插件间通信文档

参考 Songloft 官方文档：§7 插件间通信