// asyncUtils.ts — 异步兜底工具：磁盘/DB/网络等慢调用必须有超时，避免前端永久 pending

/** 磁盘/DB 加载统一超时（毫秒） */
export const DEFAULT_LOAD_TIMEOUT_MS = 8000;

/** 给 promise 加超时：超时按 reject 处理（调用方自行 catch 落到错误/重试态） */
export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
