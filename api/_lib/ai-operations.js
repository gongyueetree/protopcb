/**
 * api/_lib/ai-operations.js
 * AI 操作注册表 —— 计费边界的**唯一**定义。
 *
 * 修复的漏洞：旧接口 POST /api/gemini { prompt, capability } 由浏览器决定 capability，
 * 用户可以带着"生成完整方案"的 prompt 却声明 capability='bom.estimate' 只付 1 Credit；
 * 未知 capability 还会落到 `?? 1` 的兜底低价。
 *
 * 现在：
 *   浏览器只发 { operation, operationId, input }，**不再发送任何 prompt**。
 *   服务端按 operation 查表 → 严格校验 input → 服务端拼 prompt → 固定价格 → 调模型。
 *   未知 operation 一律 400，零扣费、零模型调用。
 *
 * 价格与前端 src/design-core/entitlements 保持一致（有测试比对），但**以本表为准**。
 */

/** 输入校验的小工具：不引入 zod（api 目录是纯 JS），够用且可读 */
const S = {
  str: (max, { min = 0 } = {}) => (v) => typeof v === 'string' && v.length >= min && v.length <= max,
  num: (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
  arr: (max, item) => (v) => Array.isArray(v) && v.length <= max && v.every(item),
  obj: (shape) => (v) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.entries(shape).every(([k, check]) => check(v[k])),
  opt: (check) => (v) => v == null || check(v),
  oneOf: (vals) => (v) => vals.includes(v),
};

const langLine = (lang) => (lang === 'en' ? 'Answer in English.\n' : '');

/** 器件清单行（子电路 / 顾问 / 框图共用） */
const compLine = S.obj({
  mpn: S.str(80, { min: 1 }),
  category: S.opt(S.str(24)),
  family: S.opt(S.str(40)),
  reference: S.opt(S.str(16)),
  description: S.opt(S.str(200)),
});

export const AI_OPERATIONS = {
  /* ───────────── 方案 ───────────── */
  'scheme.generate': {
    cost: 5,
    maxInputChars: 2000,
    validate: S.obj({ requirement: S.str(2000, { min: 2 }), lang: S.opt(S.oneOf(['zh', 'en'])) }),
    buildPrompt: ({ requirement, lang }) => `${langLine(lang)}你是资深硬件工程师。用户需求：「${requirement}」

请设计一个完整可工作的电路方案，输出器件清单与方案框图。要求：

1. 主控/电源/接口等有源器件给出真实可购买的具体型号（如 STM32C011F4P6、AMS1117-3.3）
2. 无源器件（电阻/电容/电感）给出通用值型号（如 RC0402FR-0710KL）与封装
3. footprint 用 KiCad 命名规范（如 TSSOP-20_4.4x6.5mm_P0.65mm、R_0402_1005Metric、SOT-223）
4. category 取值：mcu / power / passive / connector / ic / sensor / rf / electromech
5. 按功能分组：每个功能模块以一颗核心器件为中心，附属器件与核心器件用同一个 group 名（核心器件型号）；核心器件标 "core": true，每组至多一个核心器件
6. 方案框图：blocks 是功能块（与分组一一对应），blockLinks 描述块之间的电源与信号走向；kind 取值 blocks: power|mcu|sensor|interface|storage|rf|display|other，links: power|signal|bus
7. 至多 12 个有源器件条目；summary 为 120 字内的方案思路

严格输出 JSON（勿输出其它任何文字）：
{"summary":"…","components":[{"mpn":"…","footprint":"…","category":"…","reason":"用途简述","qty":1,"group":"核心器件型号","core":true}],"blocks":[{"id":"mcu","label":"主控","core":"…","kind":"mcu"}],"blockLinks":[{"from":"power","to":"mcu","label":"3V3","kind":"power"}]}`,
  },

  'scheme.revise': {
    cost: 3,
    maxInputChars: 8000,
    validate: S.obj({
      requirement: S.str(2000, { min: 2 }),
      feedback: S.str(1000, { min: 1 }),
      previous: S.obj({
        summary: S.opt(S.str(600)),
        components: S.arr(60, S.obj({ mpn: S.str(80, { min: 1 }), qty: S.opt(S.num(1, 64)), group: S.opt(S.str(48)), core: S.opt((v) => typeof v === 'boolean'), reason: S.opt(S.str(200)) })),
      }),
      lang: S.opt(S.oneOf(['zh', 'en'])),
    }),
    buildPrompt: ({ requirement, feedback, previous, lang }) => {
      const list = previous.components.map((c) => `- ${c.mpn}${c.qty && c.qty > 1 ? ` ×${c.qty}` : ''}${c.group ? `（组：${c.group}${c.core ? '，核心' : ''}）` : ''}${c.reason ? ` — ${c.reason}` : ''}`).join('\n');
      return AI_OPERATIONS['scheme.generate'].buildPrompt({ requirement, lang })
        + `\n\n【上一版方案】\n${previous.summary ?? ''}\n器件清单：\n${list}\n\n【用户修改意见】\n${feedback}\n\n请在上一版方案基础上按意见调整：保留未被提及的部分，只增删改必要的器件。输出格式同上。`;
    },
  },

  /* ───────────── 子电路 / 顾问 / 框图 ───────────── */
  'subcircuit.recommend': {
    cost: 2,
    maxInputChars: 1000,
    validate: S.obj({ mpn: S.str(80, { min: 1 }), manufacturer: S.opt(S.str(64)), description: S.opt(S.str(200)), lang: S.opt(S.oneOf(['zh', 'en'])) }),
    buildPrompt: ({ mpn, manufacturer, description, lang }) => `${langLine(lang)}你是资深硬件工程师。核心器件：${mpn}${manufacturer ? `（${manufacturer}）` : ''}${description ? ` — ${description}` : ''}

请给出该器件典型应用电路所需的周边器件（去耦、上拉/下拉、晶振及负载电容、复位、接口保护、电源滤波等）。
1. 只列真实需要的，不凑数；同值多只的用 qty 表示；总条目不超过 30
2. value 给出值或具体型号；category 取 passive|ic|power|connector
3. connectsTo 写核心器件的管脚名
4. footprint 必须使用 KiCad 官方库的标准封装名（如 R_0603_1608Metric、C_0402_1005Metric、SOT-23-5、Crystal_SMD_3225-4Pin_3.2x2.5mm、USB_C_Receptacle_USB2.0_16P），不确定就留空
严格输出 JSON 数组，不要其他文字：
[{"role":"作用","value":"值或型号","category":"passive|ic|power|connector","footprint":"KiCad官方封装名，可留空","connectsTo":"核心管脚名","qty":1}]`,
  },

  'advisor.analyze': {
    cost: 2,
    maxInputChars: 6000,
    validate: S.obj({ components: S.arr(200, compLine), lang: S.opt(S.oneOf(['zh', 'en'])) }),
    buildPrompt: ({ components, lang }) => `${langLine(lang)}你是资深硬件工程师。当前 PCB 画布上已有器件：
${components.map((c) => `- ${c.mpn}（${c.category ?? ''}${c.family ? '/' + c.family : ''}）`).join('\n')}

请分析构成完整可工作系统还缺哪些功能器件/子电路（晶振、复位、去耦、ESD、接口、供电等），按重要性给出至多8条。严格输出 JSON 数组，勿输出其它文字：
[{"name":"器件/子电路名","reason":"必要性(30字内)"}]`,
  },

  'block.analyze': {
    cost: 2,
    maxInputChars: 12000,
    validate: S.obj({
      components: S.arr(300, compLine),
      nets: S.opt(S.arr(400, S.obj({ name: S.str(64), members: S.arr(64, S.str(24)) }))),
      lang: S.opt(S.oneOf(['zh', 'en'])),
    }),
    buildPrompt: ({ components, nets, lang }) => `${langLine(lang)}你是资深硬件架构师。下面是一块 PCB 的器件与网络：
器件：
${components.map((c) => `- ${c.reference ?? ''} ${c.mpn}${c.category ? `（${c.category}）` : ''}`).join('\n')}
${nets?.length ? `网络：\n${nets.slice(0, 200).map((n) => `- ${n.name}: ${n.members.join(' ')}`).join('\n')}` : ''}

请划分功能子系统与信号流：
1. 每个块给出 id/label/role/kind（mcu|power|analog|rf|interface|memory|sensor|clock|protection|other）与包含的位号 refs
2. 给出块之间的连接：信号名尽量用清单里出现的网络名
3. summary 用一句话说明这块板的用途
严格输出 JSON，不要其它文字：
{"summary":"…","blocks":[{"id":"b1","label":"名称","role":"职责","kind":"mcu","refs":["U1","C1"]}],"edges":[{"from":"b1","to":"b2","signal":"SPI","kind":"power|digital|analog|clock|bus"}]}`,
  },

  /* ───────────── BOM ───────────── */
  'bom.estimate': {
    cost: 1,
    maxInputChars: 600,
    validate: S.obj({ reference: S.str(16), mpn: S.str(80, { min: 1 }), footprint: S.opt(S.str(80)), description: S.opt(S.str(200)), lang: S.opt(S.oneOf(['zh', 'en'])) }),
    buildPrompt: ({ reference, mpn, footprint, description, lang }) => lang === 'en'
      ? `Part: ${[mpn, footprint, description].filter(Boolean).join(' / ')} (refdes ${reference}).
Estimate the unit price for a 100-piece small-batch purchase in mainland China. Reply with JSON only: {"cny":number,"low":number,"high":number,"note":"basis within 20 words"}`
      : `估算该电子元件在国内小批量（100 片）采购的单价。位号 ${reference} · 型号/值 ${mpn} · 封装 ${footprint ?? '未知'}${description ? ` · ${description}` : ''}
只回一个 JSON：{"cny":数字,"low":数字,"high":数字,"note":"20字内依据"}`,
  },

  /* ───────────── 定制器件提取 ───────────── */
  'part.extract': {
    cost: 4,
    maxInputChars: 60000,
    allowAttachments: true,
    validate: S.obj({
      mode: S.opt(S.oneOf(['text', 'image', 'pdf', 'url'])),
      text: S.opt(S.str(60000)),
      url: S.opt(S.str(2000)),
      lang: S.opt(S.oneOf(['zh', 'en'])),
      // 附件在 body 顶层（pdfBase64 / imageBase64），不放进 input，见 /api/ai
    }),
    buildPrompt: ({ mode, text, url, lang }) => {
      const imageHint = mode === 'image'
        ? '\n补充：这是一张图片。请先判断它是「引脚定义图」还是「封装尺寸图」：引脚图 → 重点提取 pins（脚号+名称+类型）；封装尺寸图 → 重点提取 package（bodyW/bodyH/pitch，单位 mm，并按脚号数量推断 family）。两类信息都可见时都提取。'
        : '';
      return `${langLine(lang)}${text ? `以下是器件资料文本：\n${text}\n\n` : ''}${url ? `资料来源：${url}\n\n` : ''}${EXTRACT_PROMPT_BASE}${imageHint}`;
    },
  },

  'symbol.generate': {
    cost: 3,
    maxInputChars: 4000,
    validate: S.obj({ mpn: S.str(80, { min: 1 }), pins: S.arr(200, S.obj({ number: S.str(8), name: S.str(32), type: S.opt(S.str(16)) })), lang: S.opt(S.oneOf(['zh', 'en'])) }),
    buildPrompt: ({ mpn, pins, lang }) => `${langLine(lang)}为器件 ${mpn} 生成 KiCad 风格原理图符号的引脚布局。引脚：
${pins.map((p) => `${p.number}: ${p.name}${p.type ? ` (${p.type})` : ''}`).join('\n')}
按 KLC 规范：电源在上、地在下、输入在左、输出在右。严格输出 JSON：
{"pins":[{"number":"1","name":"VCC","side":"top|bottom|left|right","order":0}]}`,
  },
};

/** 定制器件提取的固定提示词（原在前端 CustomPartWizard，现移到服务端） */
// 字段名必须与前端 CustomPartWizard.applyExtract 一致（num/desc/side、family 枚举），
// 这是原来前端 EXTRACT_PROMPT_BASE 的服务端版本
const EXTRACT_PROMPT_BASE = `请从以上器件资料中提取信息，严格输出 JSON（勿输出其它文字）：
{"mpn":"型号","description":"30字内功能描述","category":"ic|mcu|power|sensor|connector|passive|module|rf|electromech",
"pins":[{"num":"1","name":"VCC","type":"power_in","desc":"电源","side":"top|bottom|left|right"}],
"family":"dual|quad|sot|dip|qfn|bga|custom","bodyW":4.9,"bodyH":3.9,"pitch":1.27,"leadSpan":6.0,"padLen":1.5,"padWidth":0.6,"heightMm":1.75,
"footprintName":"KiCad 封装名（如 SOIC-8_3.9x4.9mm_P1.27mm）"}
pin.type 取 KiCad 电气类型：input|output|bidirectional|tri_state|passive|free|unspecified|power_in|power_out|open_collector|open_emitter|no_connect。
side 按 KLC：电源在 top、地在 bottom、输入在 left、输出在 right。
只填写资料里能确认的字段；不确定的留空或省略，不要编造。`;

/** 价目表（与前端一致性由测试保证） */
export const OPERATION_COST = Object.fromEntries(Object.entries(AI_OPERATIONS).map(([k, v]) => [k, v.cost]));

/** 查表；未知操作返回 null（调用方必须 400，绝不兜底低价） */
export function lookupOperation(name) {
  return Object.prototype.hasOwnProperty.call(AI_OPERATIONS, name) ? AI_OPERATIONS[name] : null;
}
