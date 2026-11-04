/**
 * scene.mjs —— **画面层读数**：把「人发给守衡的那张图」交给**吃图的模型**看一眼，
 * 换回一份**结构化的、只陈述可见事实**的读数。
 *
 * ── 它补的是哪半条范围（2026-10-15）
 *
 *   PRD §5.1 对图片写的是两半：输入 **「OCR + 基础视觉识别」**，
 *   输出依据 **「图片文字、产品使用、人物行为、场景风险」**。
 *   而本项目此前**只做了 OCR 那半** —— 知识库侧与模型侧吃的都是同一份图内文字，
 *   「画面」两侧都没看过。起因是 `vision.mjs` 头注里那句话：
 *   **「守衡的模型是 `deepseek-flash`，不吃图」**。
 *
 *   ★ 那句话**是错的，2026-10-15 当场实测否掉了**（同一天、同一个端点、同一把密钥）：
 *     POST `https://api.deepseek.com/chat/completions`，`model=deepseek-flash`，
 *     content 里带 `{type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}}`
 *     → **HTTP 200**，回答：「一位女士抱着婴儿，一位男士在水槽边洗东西，
 *     厨房台面上放着两个粉色半透明球形容器。」（与那张图的实物一致）。
 *   ⇒ 不需要新引服务商、不需要新密钥：**用项目已经在用的那个端点**。
 *
 * ── 边界（每一条都有执行点，别只当注释读）
 *
 *   · **只读临时目录里的图**：`loadImage()` 会拒绝任何不在 `os.tmpdir()` 之下的路径。
 *     取字节那一步（`feishu.mjs` 的 `fetchMessageResource`，全仓唯一调用点）本来就落临时目录，
 *     用完即删 —— 本模块**不自己取字节、不联网拉图**。
 *   · **只陈述可见事实，不下结论**：提示词写死「不许判合规、不许给建议、不许编看不见的」，
 *     并要求把「看不清 / 这张图里没有」单独列进 `unclear`。
 *     ★ 为什么卡这么死：这份读数会进**模型侧**的输入去参与判定 ——
 *     如果它开始"推理"，那就不再是读数，而是**第二个判定者**，而它没有条款、没有锚点。
 *   · **读不到 ≠ 没有画面**：`ok:false`（超时/网络/JSON 解不出）与
 *     `ok:true` 但字段全空，**必须长得不一样**（与 `vision.mjs` 的 OCR 同一条纪律）。
 *     JSON 解不出时**不许**把散文当读数收下 —— 那正是 §2.4.1 那个病。
 *   · **一个字节都不留在盘上**：本模块不写文件；调用方在 `finally` 里删临时图（既有那条路径）。
 *
 * ── 红线口径（`AGENTS.md` §2.6 窄豁免，2026-10-15 Owner 当场定的加宽）
 *
 *   图片字节此前**不出机器**（只做本机 OCR）。这一层是**唯一**让图片字节离开本机的地方，
 *   而且形状被钉死：**只送人当前发给守衡的那张图**、只送画面层这一件事、
 *   送的是**同一个端点**（与素材文字同一个服务商，不新增第三方）、不归档、不进知识库。
 *   要再开一处、或换成别的服务商 ⇒ **先改 §2.6 与这里的 `SCENE_ENABLED`**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';

const execFileP = promisify(execFile);

/** 总开关。关掉 ⇒ 画面层整块不跑，读数如实记「未开」，**不假装读过**。 */
export const SCENE_ENABLED = process.env.SHOUHENG_SCENE === '0' ? false : true;

/**
 * ★★ 2026-10-16 实测逼出来的两个数（**不缩图就会拖垮回执**）：
 *   第一次真跑：她那张 813KB / 1574×894 的图，**画面层自己 4.4 s**；
 *   视频那 3 帧（1920×1080）各 **16.1 s / 21.1 s / 3.7 s = 40.9 s** —— 而回执卡是在
 *   `readInboundContent()` **之后**才发的 ⇒ 图片整条 **6.2 s**、视频 **57.4 s**，
 *   双双越过 PRD §12 那条「群 @Agent 响应 ≤5 秒」（`[metric] … prd_limit_ms=5000`）。
 *   读数**不需要** 1080p：「有没有人 / 有没有婴幼儿 / 产品在不在用」在 768px 上一样看得见。
 *   ⇒ 送模型前**先缩**（macOS 自带 `sips`，不引第三方、不联网，与 `vision.mjs` 同一条纪律），
 *     并把「缩过」这件事**如实带在读数里**（别让人以为模型看的是原分辨率）。
 */
/** ADR-0015：常规素材直接送原图；任一阈值超限才缩到该长边。 */
export const SCENE_MAX_EDGE = Number(process.env.SHOUHENG_SCENE_MAX_EDGE || 2560);
export const SCENE_SHRINK_OVER_BYTES = Number(process.env.SHOUHENG_SCENE_SHRINK_BYTES || 4 * 1024 * 1024);
export const SCENE_SOURCE_MAX_BYTES = Number(process.env.SHOUHENG_SCENE_SOURCE_MAX_BYTES || 20 * 1024 * 1024);
export const SCENE_WIRE_MAX_BYTES = Number(process.env.SHOUHENG_SCENE_WIRE_MAX_BYTES || 8 * 1024 * 1024);

/** 一次调用等的上限。画面层是**加分读数**，不许把回话拖死。 */
export const SCENE_TIMEOUT_MS = Number(process.env.SHOUHENG_SCENE_TIMEOUT_MS || 45_000);

/**
 * **要不要让它先"想"**（默认不想）。
 *
 * ★★ 2026-10-16 实测（同一张 813KB 的图、同一段提示词）：
 *     · 默认（带思考）：`reasoning 635 tokens`、**总 5.8~6.5 s**；
 *     · `thinking:{type:'disabled'}`：**总 1.8~2.0 s**、JSON 照样成形。
 *   而画面层只是**读数**（不判合规、不下结论）⇒ 那几百个思考 token 换不来判定质量，
 *   却把「@ → 回执卡」那一段顶到 PRD §12 的 **≤5 秒**线上（实测：图片整条 6.2 s ⇒ FAIL；
 *   历史 12 次同类读数**全部 pass**，最大 3564 ms —— 这是我的改动带来的回归）。
 *   ⇒ 默认关；`SHOUHENG_SCENE_THINK=1` 可开回来（A/B 复现用）。
 *   ⚠️ 端点不认这个参数时（4xx）会**自动退回一次不带它的请求**，不把读数丢掉。
 */
export const SCENE_THINK = process.env.SHOUHENG_SCENE_THINK === '1';

/** 体量档位：小图直接发。 */
const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                   '.gif': 'image/gif', '.webp': 'image/webp', '.img': 'image/jpeg',
                   '.heic': 'image/heic' };

/**
 * 提示词：**只许陈述看得见的东西**。
 * ⚠️ 改它等于改读数的口径 —— 同时要改 `scene.test.mjs` 里那几条判据（尤其「不许下结论」那条）。
 */
export const SCENE_SYSTEM = [
  '你是**画面读数器**，不是审查员。你只做一件事：把这张图里**看得见的事实**列成 JSON。',
  '',
  '硬规矩（违反任何一条，这份读数就是废的）：',
  '1. **只写你在这张图里真看到的**。看不清的、被挡住的、不属于这张图的，一律写进 `unclear`。',
  '2. **不许判合规、不许给建议、不许下结论**（不写「违规」「风险」「建议改为」这类判断）。',
  '3. **不许推断看不见的东西**：月龄只能写「婴幼儿/儿童/成人」这一档，不许写「6 个月」；',
  '   不许推断品牌合作、不许推断声音、不许推断这张图之外的情节。',
  // ★★ 2026-10-16 实测（A/B 对照）：关掉思考后模型把品牌读成了 `MAMAZY`（实际是 momcozy）——
  //   **猜品牌名**这类错误比"少写一条"坏得多（它会进模型侧输入，变成对素材的错误指控）。
  //   分工本来就清楚：**"图上写着什么"归本机 OCR（逐字、可回源）**；
  //   画面层只报「有没有文字/标识存在」。所以这一条从"逐字照抄"改成"不许猜"。
  '4. `visible_marks` **只报"有没有"**：有没有文字/标识存在、大致在最显眼处还是边角。',
  '   **不许写你猜的品牌名或文字内容** —— 逐字内容以另一路本机 OCR 为准；',
  '   只有当你**百分之百看得清**时才可照抄，否则写「有文字，认不清」。',
  // ★★ 2026-10-16 加（Owner：「第 17 行报告里「嫩圈o」「白」，图片中有吗？你验证下」）——
  //   实测：那张**通篇英文**的商品图上，本机 OCR 在「控制面板的 Cleaning 图标」与
  //   「纸盒上印的 30」两处读出了汉字（置信度 0.3 = 引擎下限），一路出成
  //   「图上有中文、要改成英文」的整改建议。**判它真假的唯一一手证据在画面这层** ——
  //   这一层真的看了像素，OCR 那层只是在猜。
  //   ⇒ 新增一格 `text_script`：**只报用的是什么文字（脚本），不报内容**。
  //     它既不违反上面那条「不许写文字内容」，又给了下游一个可核的事实。
  //     ⚠️ 少了这一格，「汉字声称闸」永远拿不到确认 ⇒ 会连**真中文**一起降级。
  '4b. `text_script` **只报用的是什么文字**（脚本），**一个字的内容都不许写**：',
  '   `英文` / `中文` / `中英混排` / `其他文字` / `无文字` / `无法辨认`（看不清就写这个，别猜）。',
  '   判据是**你眼睛看到的字形**：看到汉字就写「中文」，看到英文字母写「英文」，两种都有写「中英混排」。',
  '   宁可写「无法辨认」，也不许把看不清的东西说成某种文字。',
  '4c. `clean_text` 只抄**百分之百看清的主文案 / 主字幕**，用于校准本机 OCR：',
  '   · 逐字保留大小写、空格、标点和德/法/西语变音符；一行一个字符串；',
  '   · 排除截图水印、审阅叠加层、手机 App 背景 UI 小字、衣服图案和不确定字符；',
  '   · 看不清就不要写；不许根据语义补字，也不许把它写成合规判断或修改建议。',
  '5. 画面里出现婴幼儿、儿童、可识别人物、产品正在被使用（或贴近人体）时，',
  '   **必须**如实写进 `risk_cues` —— 只陈述「我看到了什么」，不要解释它为什么重要。',
  '5b. 多面板/拼图里每个独立人物都单独列出，不能把不同面板的人合并或重复；用 `panel` 标明位置（如左上/右下/中部）。',
  '5c. 对每个婴幼儿必须单独判断 `sleep_scene`。若是睡眠场景，必须逐个判睡姿「仰卧/侧卧/俯卧/看不清」，并给出 `sleep_posture_basis`（只写可见身体朝向线索）与面板位置。',
  '   判姿势只看婴儿自身躯干/脸部/肩髋朝向：侧身朝向床面或身体侧面着地才记「侧卧」；不可把成人侧躺、同床、图片文字或安全建议当作婴儿睡姿证据。',
  '   不是睡眠场景写 `sleep_posture=不适用`；睡眠状态或姿势被遮挡、看不清、证据不足时写 `看不清`，绝不能默认仰卧。',
  '   如果有多个婴儿/多个面板，逐个给出记录；不能因数组长度或篇幅限制漏项。',
  // ★★ 2026-10-21（Owner：「奶瓶倒着放为什么没有审到」）：
  //   实测同一张图两次读数，容器**时有时无**（10:46 有「白色小瓶」，11:18 整个床头柜的小物件都没了），
  //   而且 schema 里**没有"朝向"这一维** ⇒ "倒着放"永远读不出来，下游只能写「读不到」。
  //   两条硬规矩：① 容器类**必列**（不许因为认不出牌子/很小就整条不写）；② 容器必须给朝向。
  '6. **台面/柜面上的容器类物件**（瓶、杯、罐、盒、壶、奶瓶、水杯等）必须逐个写进 `products`，',
  '   即使很小、即使看不清上面的字、即使不是画面主体 —— **不许因为"认不出牌子"就整条不写**。',
  '7. 容器/器皿的 `orientation` **必填**，只许这几值：',
  '   `正放`（口朝上正常放着）｜`倒置`（口朝下/底朝上）｜`侧放`｜`悬空`（底下没有支撑面）｜',
  '   `贴边`（紧贴桌沿或柜边）｜`看不清`。**看不清就写「看不清」，不许猜**（猜出来的朝向比漏掉更坏）。',
  '8. 看到「倒置、翻倒、液体外溢、悬空、贴边」这类**姿态异常**时，必须在 `risk_cues` 里逐条写出来',
  '   （只写看到什么，不解释为什么重要）。',
  '',
  '只输出一个 JSON 对象，不要任何解释文字。people 最多 8 项以覆盖多面板人物；其他数组最多 4 项，每项不超过 25 个字。',
  '字段：',
  '{',
  '  "setting": "厨房 / 浴室 / 卧室 / 客厅 / 户外 / 影棚 / 其他（或：看不清）",',
  '  "people": [{"panel":"左上/右上/中部/右下等可见区域","kind":"婴幼儿|儿童|成人|分不清","doing":"在做什么（看得见的动作）", "sleep_scene":true, "sleep_posture":"仰卧|侧卧|俯卧|看不清|不适用", "sleep_posture_basis":"只写婴儿自身可见朝向线索；看不清时写原因"}],',
  '  "products": [{"what":"看得见的物品（逐字描述外形即可，认不出牌子就只说外形）","in_use":true,',
  '                "orientation":"正放|倒置|侧放|悬空|贴边|看不清（容器类必填）"}],',
  '  "visible_marks": ["图上真有的商标或文字标识（逐字）"],',
  '  "text_script": "英文 / 中文 / 中英混排 / 其他文字 / 无文字 / 无法辨认",',
  '  "clean_text": ["百分之百看清的主文案或主字幕；一行一个；不确定则留空数组"],',
  '  "risk_cues": ["看得见、且与内容审查有关的事实（婴幼儿出镜、产品贴近人体、疑似合成痕迹…）"],',
  '  "unclear": ["看不清或这张图里没有的信息"]',
  '}',
].join('\n');

/** 路径守卫：**只认临时目录里的文件**（见头注那条边界）。 */
export function assertTempPath(p) {
  const abs = path.resolve(String(p ?? ''));
  const tmp = path.resolve(os.tmpdir());
  if (!abs.startsWith(tmp + path.sep) && !abs.startsWith('/tmp' + path.sep)) {
    throw new Error(`画面层只读临时目录里的图（拒绝 ${abs}）—— 取字节那一步落在 ${tmp}，见 §2.6 窄豁免`);
  }
  return abs;
}

/** `text_script` 的闭集（解析侧只认这几个值；见 `parseScene` 里那段理由）。 */
export const TEXT_SCRIPTS = Object.freeze(['英文', '中文', '中英混排', '其他文字', '无文字', '无法辨认']);

/** 容器朝向的闭集（2026-10-21 加）。**看不清就写「看不清」，不许猜**。 */
export const ORIENTATIONS = Object.freeze(['正放', '倒置', '侧放', '悬空', '贴边', '看不清']);

/** 朝向的同义写法 → 闭集（**只做确定的归一，不做猜测**）。闭集外一律落「未给」。 */
export const ORIENTATION_SYNONYMS = Object.freeze({
  朝下: '倒置', 口朝下: '倒置', 底朝上: '倒置', 翻倒: '倒置', 倒扣: '倒置', 倒放: '倒置',
  侧躺: '侧放', 平放侧着: '侧放', 侧着放: '侧放',
  没支撑: '悬空', 没放稳: '悬空',
  贴桌沿: '贴边', 贴柜边: '贴边', 靠边: '贴边',
  立着: '正放', 正常放着: '正放', 口朝上: '正放',
});

/** 姿态异常的朝向（「倒着放」属于这一类）。 */
export const ORIENTATION_ABNORMAL = Object.freeze(['倒置', '侧放', '悬空', '贴边']);

/** 容器类物件的判据（口径：外形像瓶/杯/罐/盒/壶 —— 只看读数里 `what` 的字面）。 */
export const CONTAINER_RE = /瓶|杯|罐|盒|壶|奶瓶|水壶|容器|器皿/;

/**
 * 从读数里挑出「**容器 + 姿态异常**」的那些物品（倒置/侧放/悬空/贴边）。
 * 纯函数，给下游闸门用：读数里明明有倒置容器，清单却一个字没提 ⇒ 判红。
 * @param {object} scene - `parseScene().scene`
 * @returns {Array<{what:string, orientation:string}>}
 */
export function abnormalContainers(scene) {
  const products = Array.isArray(scene?.products) ? scene.products : [];
  return products.filter((p) => p && p.what && CONTAINER_RE.test(String(p.what))
    && ORIENTATION_ABNORMAL.includes(p.orientation));
}

/** 每个婴儿/面板独立投给睡姿核对闸；状态不明时按未确认处理，不默认排除。 */
export function infantSleepReadings(scenes = []) {
  return scenes.flatMap((scene, i) => (scene?.people ?? [])
    .filter((p) => /婴幼儿|婴儿/.test(String(p?.kind ?? ''))
      && !(p.sleep_scene === false || (p.sleep_scene === true && p.sleep_posture === '不适用')))
    .map((p) => ({
      image: `图 ${i + 1}`,
      panel: String(p.panel ?? '').trim(),
      sleep_scene: p.sleep_scene,
      position: p.sleep_scene === false || (p.sleep_scene === true && p.sleep_posture === '不适用')
        ? '不适用' : p.sleep_scene !== true && (p.sleep_posture === '不适用' || p.sleep_posture === '未给')
          ? '看不清' : p.sleep_scene === true && p.sleep_posture === '未给'
        ? '看不清' : (p.sleep_posture || '看不清'),
      basis: String(p.sleep_posture_basis ?? '').trim(),
    })));
}

/**
 * 把模型回来的文本读成**读数**（纯函数 —— 判据只有这一处，喂样本就能证）。
 *
 * ★ 解不出 JSON ⇒ `ok:false`（**不是**「这张图没画面」）。两种结局必须分得开。
 * @returns {{ok:boolean, scene?:object, error?:string}}
 */
export function parseScene(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '画面模型回了空内容' };
  // 允许它包在 ```json 里 —— 只脱一层围栏，不做别的猜测
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: `画面读数不是 JSON（前 80 字：${body.slice(0, 80)}）` };
  let o;
  try { o = JSON.parse(body.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: `画面读数 JSON 解不出：${e?.message ?? e}` }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: '画面读数不是对象' };
  const arr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  const cleanText = arr(o.clean_text).filter((x) => typeof x === 'string')
    .map((x) => x.trim()).filter(Boolean);
  return {
    ok: true,
    scene: {
      setting: String(o.setting ?? '').trim() || '未给',
      people: arr(o.people).map((p) => (typeof p === 'string' ? { kind: p, doing: '', panel: '', sleep_scene: null,
        sleep_posture: '未给', sleep_posture_basis: '' } : {
        kind: String(p?.kind ?? '').trim() || '分不清',
        doing: String(p?.doing ?? '').trim(),
        panel: String(p?.panel ?? '').trim(),
        sleep_scene: typeof p?.sleep_scene === 'boolean' ? p.sleep_scene : null,
        sleep_posture: ['仰卧', '侧卧', '俯卧', '看不清', '不适用'].includes(String(p?.sleep_posture ?? '').trim())
          ? String(p.sleep_posture).trim() : '未给',
        sleep_posture_basis: String(p?.sleep_posture_basis ?? '').trim(),
      })).filter((p) => p.kind !== '分不清' || p.doing),
      products: arr(o.products).map((p) => {
        const base = typeof p === 'string' ? { what: p, in_use: null } : {
          what: String(p?.what ?? '').trim(),
          in_use: typeof p?.in_use === 'boolean' ? p.in_use : null,
        };
        // ★ 2026-10-21：朝向归一。同义写法收下（`朝下/口朝下/底朝上` → 倒置），
        //   闭集外的模糊说法一律**不猜**（→ '未给'，下游据此判「读不到」）。
        const raw = (p && typeof p === 'object') ? String(p.orientation ?? '').trim() : '';
        const norm = ORIENTATION_SYNONYMS[raw] ?? (ORIENTATIONS.includes(raw) ? raw : '未给');
        return { ...base, orientation: norm };
      }).filter((p) => p.what),
      visible_marks: arr(o.visible_marks).map((x) => String(x).trim()).filter(Boolean),
      // ★ 2026-10-16：**只有出现在闭集里的值才收** —— 模型爱自由发挥（写「中文和英文混着」），
      //   而那会让下游的「声称闸」把确认判据变成模糊匹配。不在闭集 ⇒ 落「未给」，
      //   下游据此**判不了确认**（那是诚实的一侧：宁可降级，不许拿一句模糊话当证据）。
      text_script: (() => {
        const v = String(o.text_script ?? '').trim();
        return TEXT_SCRIPTS.includes(v) ? v : '未给';
      })(),
      clean_text: cleanText.slice(0, 20),
      // 限量后的文字不能冒充全文；完成闸据此单列素材读取缺项。
      clean_text_truncated: cleanText.length > 20,
      risk_cues: arr(o.risk_cues).map((x) => String(x).trim()).filter(Boolean),
      unclear: arr(o.unclear).map((x) => String(x).trim()).filter(Boolean),
    },
  };
}

/**
 * 读数 → 摊给**模型侧**看的文本块（**唯一产者**）。
 *
 * ★ 为什么逐项摊开、不压成一句：模型侧要拿它判 PRD 那三类
 *   （产品使用 / 人物行为 / 场景风险），压成一句等于**替它挑掉了它需要的信息**。
 * ★ 空的那几项**明写「（读数里没有）」**：不写，模型会以为"没提就是没有"；
 *   写了它才知道这是读数的边界，而不是事实。
 */
export function sceneBlock(scene) {
  const s = scene ?? {};
  const L = [];
  const line = (k, v, empty) => L.push(`- ${k}：${v && String(v).trim() ? v : (empty ?? '（读数里没有）')}`);
  line('场景', s.setting && s.setting !== '未给' ? s.setting : '');
  line('人物', (s.people ?? []).map((p) => [p.panel, p.kind, p.doing,
    p.kind === '婴幼儿' ? `睡眠场景：${p.sleep_scene === true ? '是' : p.sleep_scene === false ? '否' : '未确认'}；睡姿：${p.sleep_posture || '未给'}` : '',
    p.kind === '婴幼儿' && p.sleep_scene === true ? `姿势依据：${p.sleep_posture_basis || '未给'}` : '']
    .filter(Boolean).join(' · ')).join('；'));
  line('物品', (s.products ?? []).map((p) => p.what + (p.in_use === true ? '（正在被使用）' : '')
    + (p.orientation && p.orientation !== '未给' ? `（朝向：${p.orientation}）` : '')).join('；'));
  line('可见标识', (s.visible_marks ?? []).join('；'));
  // ★ 2026-10-16：文字**脚本**（英文/中文/中英混排…）—— 汉字声称闸的确认依据。
  line('图上文字用的是什么文字', s.text_script && s.text_script !== '未给' ? s.text_script : '');
  line('视觉校准文字', (s.clean_text ?? []).join('；'));
  line('画面线索', (s.risk_cues ?? []).join('；'));
  line('读数自报看不清的', (s.unclear ?? []).join('；'));
  return L.join('\n');
}

/** 读数 → 一行给人看的短语（日志与报告附录共用；**唯一产者**）。 */export function sceneLine(scene) {
  if (!scene || !scene.ok) return '';
  const s = scene.scene ?? {};
  const parts = [];
  if (s.setting && s.setting !== '未给') parts.push(`场景=${s.setting}`);
  if (s.people?.length) parts.push(`人物=${s.people.map((p) => [p.kind, p.doing].filter(Boolean).join('')).join('、')}`);
  if (s.products?.length) parts.push(`物品=${s.products.map((p) => p.what + (p.in_use ? '（在用）' : '')).join('、')}`);
  if (s.visible_marks?.length) parts.push(`可见标识=${s.visible_marks.join('、')}`);
  if (s.text_script && s.text_script !== '未给') parts.push(`文字=${s.text_script}`);
  if (s.risk_cues?.length) parts.push(`画面线索=${s.risk_cues.join('、')}`);
  return parts.join('｜');
}

/**
 * 送模型前**缩一下**（纯本机：macOS 自带 `sips`）。
 *
 * 落点只许是**临时目录**（与取字节那条豁免同一个形状），调用方用完即删。
 * 缩图失败**不阻断**：退回原图，并把「没缩成」如实记进读数 —— 不许假装缩过。
 * @returns {{path:string, bytes:number, shrunk:boolean, cleanup?:Function, note?:string}}
 */
const _dimensionReads = new Map();

/** 本机只读尺寸；读不到返回 null，调用方保留原图并显式留痕。 */
export async function imageDimensions(p) {
  const abs = assertTempPath(p);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const key = `${abs}:${st.size}:${st.mtimeMs}`;
  if (_dimensionReads.has(key)) return _dimensionReads.get(key);
  const pending = (async () => {
    try {
      const { stdout = '' } = await execFileP('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', abs],
        { timeout: 10_000, maxBuffer: 1 << 20 });
      const w = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
      const h = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
      return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
    } catch { return null; }
  })();
  _dimensionReads.set(key, pending);
  return pending;
}

export async function shrinkForModel(p, { maxEdge = SCENE_MAX_EDGE,
  overBytes = SCENE_SHRINK_OVER_BYTES } = {}) {
  const abs = assertTempPath(p);
  const origBytes = fs.statSync(abs).size;
  const dims = await imageDimensions(abs);
  const dimMeta = dims ? { origWidth: dims.width, origHeight: dims.height } : {};
  const passthrough = (note) => ({ path: abs, bytes: origBytes, shrunk: false, ...dimMeta,
    policy: 'original-passthrough', ...(note ? { note } : {}) });
  const overDimension = !!dims && Math.max(dims.width, dims.height) > maxEdge;
  if (maxEdge <= 0 || (origBytes <= overBytes && !overDimension)) {
    return passthrough(dims ? undefined : '读不到图片尺寸，保守保留原图');
  }
  const out = path.join(os.tmpdir(), `shouheng-scene-small-${process.pid}-${Date.now().toString(36)}.jpg`);
  const cleanup = () => { try { fs.unlinkSync(out); } catch { /* 删不掉不影响读数 */ } };
  try {
    await execFileP('sips', ['-Z', String(maxEdge), '-s', 'format', 'jpeg', abs, '--out', out],
      { timeout: 20_000, maxBuffer: 1 << 20 });
    const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (!bytes) { cleanup(); return passthrough('缩图产出 0 字节 ⇒ 退回原图'); }
    return { path: out, bytes, shrunk: true, origBytes, ...dimMeta, maxEdge,
      policy: overDimension && origBytes > overBytes ? 'bytes-and-dimension'
        : (overDimension ? 'dimension' : 'bytes'), cleanup };
  } catch (e) {
    cleanup();
    return passthrough(`缩图没成（${e?.code ?? e?.message}）⇒ 退回原图`);
  }
}

/**
 * 跑一次画面层读数。
 *
 * @param {string} imagePath 临时目录里的图（`assertTempPath` 会拒别的路径）
 * @returns {Promise<{ok:boolean, scene?:object, ms:number, error?:string}>}
 *   ⚠️ **永不抛** —— 画面层是加分读数，它失败不该让这次回话失败
 *      （与 `vision.ocrImage` 的调用点同一条纪律：任何一张图读不到都不该让整条回话挂掉）。
 *   ⚠️ `ok:false` 的语义是**「这一张我没读到画面」**，不是「这张图没有画面」。
 */
export async function sceneRead(imagePath, { model = config.vision?.sceneModel || config.llm.model,
                                         baseUrl = config.vision?.baseUrl || config.llm.baseUrl,
                                         apiKey = config.vision?.apiKey || config.llm.apiKey,
                                         fallbackModel = config.vision?.fallbackModel || config.llm.model,
                                         timeoutMs = SCENE_TIMEOUT_MS,
                                         maxTokens = 4000, fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  // ★ 关掉时是 **`skipped`**（这一单没跑），不是 `ok:false` 的失败 ——
  //   三种结局必须分得开：**没跑**（skipped）／**没读到**（未测）／**读到了**。
  //   第一版这里只回 `ok:false`，于是「功能关着」在报告里被印成「没读到（未测）」，
  //   而两者引出的下一步完全不同（一个是没人开，一个是环境/网络出问题）。
  if (!SCENE_ENABLED) return { ok: false, skipped: true, ms: 0, error: '画面层未开（SHOUHENG_SCENE=0）' };
  let abs;
  try { abs = assertTempPath(imagePath); }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
  let buf;
  try { buf = fs.readFileSync(abs); }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: `读不到那张临时图：${e?.code ?? e?.message}` }; }
  if (!buf.length) return { ok: false, ms: Date.now() - t0, error: '那张临时图是 0 字节' };
  if (buf.length > SCENE_SOURCE_MAX_BYTES) {
    return { ok: false, ms: Date.now() - t0,
             error: `原图太大（${buf.length}B > ${SCENE_SOURCE_MAX_BYTES}B）⇒ 没送模型` };
  }
  // 每次送审（含视频帧与启动试纸）都重新读画面，不读取或写入历史结果缓存。
  // ★ ADR-0015：常规图原字节直通；只有 >4MB 或长边 >2560px 才缩。
  const small = await shrinkForModel(abs).catch((e) => ({ path: abs, bytes: buf.length, shrunk: false,
                                                          note: `缩图抛异常：${e?.message ?? e}` }));
  let sendBuf;
  try { sendBuf = fs.readFileSync(small.path); }
  catch (e) { small.cleanup?.(); return { ok: false, ms: Date.now() - t0, error: `读不到缩过的图：${e?.code ?? e?.message}` }; }
  if (sendBuf.length > SCENE_WIRE_MAX_BYTES) {
    small.cleanup?.();
    return { ok: false, ms: Date.now() - t0, sent: sentNote(small),
      error: `送模型的图仍超过线缆上限（${sendBuf.length}B > ${SCENE_WIRE_MAX_BYTES}B）` };
  }
  const mime = EXT_MIME[path.extname(small.path).toLowerCase()] ?? 'image/jpeg';
  const isGemini = /gemini/i.test(String(model ?? ''));
  const body = {
    model, max_tokens: maxTokens, temperature: 0,
    ...(SCENE_THINK ? {} : (isGemini ? { reasoning_effort: 'low' } : { thinking: { type: 'disabled' } })),   // 见 SCENE_THINK 头注
    messages: [
      { role: 'system', content: SCENE_SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: '读这一张。只输出 JSON。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${sendBuf.toString('base64')}` } },
      ] },
    ],
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let curBase = baseUrl;
    let curKey = apiKey;
    const callOnce = (b) => fetchImpl(curBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${curKey}` },
      body: JSON.stringify(b),
    });
    let r;
    try {
      r = await callOnce(body);
    } catch (netErr) {
      // 若本机 magpie.app 不可达且注射的是原生 fetch，回退到主 LLM 端点再试一次
      if (fetchImpl === fetch && curBase !== config.llm.baseUrl) {
        curBase = config.llm.baseUrl;
        curKey = config.llm.apiKey;
        r = await callOnce({ ...body, model: config.llm.model });
      } else {
        throw netErr;
      }
    }
    // ★ 端点不认 `thinking` 时（4xx）**退回一次不带它的**：不许因为一个可选参数把读数丢掉。
    if (!r.ok && !SCENE_THINK && r.status >= 400 && r.status < 500) {
      const t0msg = await r.text().catch(() => '');
      console.log(`[scene] ⚠️ 端点不认 thinking 参数（HTTP ${r.status}）⇒ 退回带思考的那次请求`
        + `（会慢约 2~3 倍）：${t0msg.slice(0, 120)}`);
      const { thinking, reasoning_effort, ...without } = body;
      r = await callOnce(without);
    }
    // 若首选视觉模型返回 4xx/5xx 且有备用模型，自动切换 fallbackModel 再试一次
    if (!r.ok && fetchImpl === fetch && fallbackModel && fallbackModel !== body.model) {
      r = await callOnce({ ...body, model: fallbackModel, thinking: { type: 'disabled' } });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, ms: Date.now() - t0, sent: sentNote(small), error: `画面模型 HTTP ${r.status}：${t.slice(0, 200)}` };
    }
    let j = await r.json();
    let choice = j?.choices?.[0] ?? {};
    let raw = choice?.message?.content ?? '';
    // A partial scene description is not useful evidence. Retry once with
    // twice the output budget; the original total timeout remains in force.
    if (choice?.finish_reason === 'length') {
      console.log(`[scene] ⚠️ 画面读数被截断 ⇒ 有界重试一次（max_tokens ${maxTokens} → ${maxTokens * 2}）`);
      r = await callOnce({ ...body, max_tokens: maxTokens * 2 });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { ok: false, ms: Date.now() - t0, sent: sentNote(small),
          error: `画面模型重试 HTTP ${r.status}：${t.slice(0, 200)}` };
      }
      j = await r.json();
      choice = j?.choices?.[0] ?? {};
      raw = choice?.message?.content ?? '';
    }
    // ★★ 2026-10-15 当场踩到并修掉：**`finish_reason: 'length'` 的 JSON 是被切开的**，
    //   而 `JSON.parse` 只会报一句「position 518 处少了 `,`」—— **指向完全无关的方向**
    //   （我第一版就是先怀疑模型写坏了 JSON，其实是我给 700 tokens 不够）。
    //   判据必须比**内容的完整性**，不能比那句报错：
    //   截断 ⇒ **未测**（`ok:false`），**不许**把半份读数收下，也不许说成「没有画面」。
    if (choice?.finish_reason === 'length') {
      return { ok: false, ms: Date.now() - t0, sent: sentNote(small),
               error: `画面读数**被截断**（max_tokens=${maxTokens} 用尽）⇒ 这一张的画面层是**未测**`
                 + '（不是「没有画面」，也不是「读数是空的」）' };
    }
    const p = parseScene(raw);
    if (p.ok) {
      return { ok: true, scene: p.scene, ms: Date.now() - t0, sent: sentNote(small) };
    }
    return { ok: false, ms: Date.now() - t0, sent: sentNote(small), error: p.error };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : `${e?.cause?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}`;
    return { ok: false, ms: Date.now() - t0, error: why };
  } finally {
    clearTimeout(timer);
    small.cleanup?.();          // 缩过的那份**用完即删**（与取字节同一条纪律）
  }
}

/** 「送模型的是什么」——读数里必须看得见（别让人以为它看的是原分辨率）。 */
function sentNote(small) {
  return { bytes: small.bytes, shrunk: !!small.shrunk, ...(small.origBytes ? { origBytes: small.origBytes } : {}),
           ...(small.origWidth ? { origWidth: small.origWidth, origHeight: small.origHeight } : {}),
           ...(small.maxEdge ? { maxEdge: small.maxEdge } : {}), ...(small.policy ? { policy: small.policy } : {}),
           ...(small.note ? { note: small.note } : {}) };
}

/**
 * 启动试纸：**这条路还通不通，第一屏就要看得见**（与 `vision.preflight` 同一形状）。
 *
 * 用本仓资产图（`tools/agent/__fixtures__/ocr-sample.png`，26KB，不是从飞书取来的），
 * 真跑一次；读数里必须**至少有一项看得见的字段** —— 只测「HTTP 200」测不出「它其实什么都没看」。
 */
export async function preflight({ fetchImpl = fetch } = {}) {
  if (!SCENE_ENABLED) return { ok: false, skipped: true, detail: '画面层未开（SHOUHENG_SCENE=0）' };
  const fixture = path.join(import.meta.dirname, '__fixtures__', 'ocr-sample.png');
  if (!fs.existsSync(fixture)) return { ok: false, detail: `试纸不在：${fixture}` };
  // 试纸在仓里、不在临时目录 ⇒ 复制一份到临时目录再跑（守卫不开口子）
  const tmp = path.join(os.tmpdir(), `shouheng-scene-preflight-${process.pid}.png`);
  try {
    fs.copyFileSync(fixture, tmp);
    const r = await sceneRead(tmp, { fetchImpl, timeoutMs: 30_000 });
    if (!r.ok) return { ok: false, detail: r.error };
    const line = sceneLine(r);
    return { ok: !!line, detail: `${line || '（读数全空 —— 它其实什么都没看）'} · ${r.ms}ms`, scene: r.scene };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 删不掉不影响读数 */ }
  }
}
