/**
 * timefmt.mjs —— 北京时间格式化（守衡内部唯一一份）
 *
 * 存在的理由（一次真实事故）：
 *
 *   `now` 工具返回的是北京时间，而 `recent_messages` 曾经返回
 *   `new Date(...).toISOString()`，也就是 **UTC**（形如 `2026-09-16T03:12:48.165Z`）。
 *   同一次对话里两种时间基准并存，模型于是做了第二次换算：
 *   真实北京 11:12 的一条消息，被守衡在群里说成「22:57 和 23:12」——
 *   它把已经带时区标识的 UTC 又减了 8 小时。
 *
 *   这个错误的性质很关键：**它是静默的**。没有报错、没有异常、日志干净，
 *   只是守衡对外说了错的时间。凡是「时间基准不统一」造成的错，都会长这样。
 *
 * 所以时间只在这里定义一次，所有对外可见的时间都走这里，
 * 一律输出北京时间，并且和 `now` 工具的写法保持同一套实现 ——
 * 两份实现只要存在，就一定会再次漂移。
 */

const SHANGHAI = 'Asia/Shanghai';

/** 固定给出 `YYYY-MM-DD HH:mm:ss`（北京时间）。用 formatToParts 逐字段取值 */
function beijingParts(d) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value])
  );
  // en-CA + hour12:false 在午夜可能给出 hour='24'，必须归一，否则会出现「24:05」。
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}:${parts.second}`,
  };
}

/** 北京时间的星期（如「星期三」） */
function beijingWeekday(d) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: SHANGHAI, weekday: 'long' }).format(d);
}

/** 真实时区偏移（形如 `+08:00`）。不硬编码 +8，免得将来时区规则变化后悄悄出错 */
function beijingOffset(d) {
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: SHANGHAI, timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = tzName.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+08:00';
}

/**
 * 把一个时间点格式化成守衡对外的标准时间对象。
 * @param {Date|number|string} input  Date / 毫秒 / 可被 Date 解析的字符串
 * @returns {{beijing_time:string,date:string,time:string,weekday:string,timezone:string,iso:string,unix:number}}
 */
export function beijingDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    // 不抛：一条消息时间戳坏掉，不该让整个工具调用失败。
    return { error: '时间戳无法解析', raw: String(input) };
  }
  const { date, time } = beijingParts(d);
  const weekday = beijingWeekday(d);
  return {
    beijing_time: `${date} ${time} ${weekday}`,
    date,
    time,
    weekday,
    timezone: `Asia/Shanghai (UTC${beijingOffset(d)})`,
    iso: d.toISOString(),
    unix: Math.floor(d.getTime() / 1000),
  };
}

/**
 * 只要「北京时间」这一行字符串，用于消息列表这类不需要完整字段的场景。
 * 例：`2026-09-16 12:26:20 星期三`
 */
export function beijingString(input) {
  const r = beijingDateTime(input);
  return r.error ? `(时间未知：${r.raw})` : r.beijing_time;
}
