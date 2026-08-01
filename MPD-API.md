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

所有 API 使用 `songloft.comm.call(entryPath, action, payload, timeout)` 调用：

```typescript
var result = await songloft.comm.call("mpd-player", "action-name", { ... }, 5000);
```

## 返回值格式

```typescript
{
  success: true | false,    // 是否成功
  data?: any,               // 返回数据（仅 status / get-queue 有）
  error?: string            // 错误信息（仅 success=false 时有）
}
```

## API 参考

### 播放控制

| Action | 参数 | 说明 |
|--------|------|------|
| `play` | `{ songId: number }` | 立即播放指定歌曲（需 songId 来自 Songloft 歌曲库） |
| `play-url` | `{ url: string, title?: string, artist?: string }` | 直接播放在线音频 URL，不经过歌曲库 |
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
| `queue-append` | `{ songIds?: number[], urls?: string[] }` | 追加歌曲/URL 到队列末尾（可同时传 songIds 和 urls） |
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
| `status` | `{}` | 获取当前播放状态（含当前歌曲、进度、音量、播放模式等） |

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

### 在线音乐推送：直接播放 URL

```typescript
// 直接播放在线音频，不经过 Songloft 歌曲库
await songloft.comm.call("mpd-player", "play-url", {
  url: "https://example.com/audio.mp3",
  title: "播客 episode-1",   // 可选，DLNA 模式会用到
  artist: "主播"              // 可选
});
```

### 播放控制：上下首

```typescript
await songloft.comm.call("mpd-player", "prev", {}, 5000);
await songloft.comm.call("mpd-player", "next", {}, 5000);
```

### 队列管理：追加歌曲和 URL

```typescript
// 同时追加库内歌曲和外部 URL
await songloft.comm.call("mpd-player", "queue-append", {
  songIds: [201, 202],
  urls: ["https://example.com/audio.mp3"]
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
- `play-url` 支持 MPD 和 DLNA 两种输出模式，MPD 模式直接播 URL，DLNA 模式会构建播放项推送给 DLNA 设备
- `queue-replace` 会清空当前队列，谨慎使用
- `pause`/`resume` 内部会判断当前状态，不会误操作
- `play-url` 的 `title` 和 `artist` 在 DLNA 模式下会显示在设备上，建议传入
- `queue-append` 同时支持 `songIds`（库内歌曲）和 `urls`（外部 URL），可单独传或混合传
- `queue-remove` 支持 `position`（单条）和 `positions`（批量），至少传一个
- `queue-jump` 和 `queue-move` 的 position 均为 1-based
- `set-mode` 只修改传入的字段，不传的字段保持当前值不变

## 附录：Songloft 插件间通信文档

参考 Songloft 官方文档：§7 插件间通信