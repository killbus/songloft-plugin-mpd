export const DEFAULT_FIFO_PATH = "/run/snapcast/songloft.fifo";
export const DEFAULT_FIFO_FORMAT = "44100:16:2";

/** Validate before writing preferences or interpolating values into mpd.conf. */
export function validateFifoPreferences(fifoPath: unknown, fifoFormat: unknown): void {
  if (
    typeof fifoPath !== "string" ||
    !fifoPath.startsWith("/") ||
    fifoPath.length > 4095 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/.test(fifoPath) ||
    fifoPath.slice(1).split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("FIFO 路径必须是绝对 POSIX 文件路径，不能包含控制字符、双引号、反斜杠或空/点路径段。");
  }
  if (typeof fifoFormat !== "string" || fifoFormat !== fifoFormat.trim() || !/^[0-9]{4,6}:(16|24|32):[12]$/.test(fifoFormat)) {
    throw new Error("FIFO PCM 格式必须为 rate:bits:channels；采样率 8000–384000，位深 16/24/32，声道 1/2。");
  }
  const rate = Number(fifoFormat.split(":")[0]);
  if (rate < 8000 || rate > 384000) {
    throw new Error("FIFO PCM 采样率必须在 8000–384000 之间。");
  }
}

/** A mention in another plugin section does not advertise a FIFO output. */
export function hasFifoOutput(version: string): boolean {
  let inOutputs = false;
  for (const rawLine of version.toLowerCase().split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.startsWith("output plugins:")) {
      inOutputs = true;
      line = line.slice("output plugins:".length);
    } else if (inOutputs && line.includes(":")) {
      break;
    }
    if (inOutputs && line.trim().split(/\s+/).includes("fifo")) {
      return true;
    }
  }
  return false;
}
