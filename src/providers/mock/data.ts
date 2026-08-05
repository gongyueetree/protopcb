/**
 * providers/mock/data.ts
 * 演示数据 —— 迁移自 legacy App.jsx，补全封装几何(courtyard)。
 * 正式版本由 EzplmComponentDataProvider 替换，结构保持一致。
 */
import type { FootprintGeometry } from '../../design-core/geometry/types';
import type {
  ComponentSearchResult,
  FootprintOption,
  ComponentAlternative,
  PeripheralCircuitRecommendation,
} from '../types';
import type { ComponentCategory } from '../../design-core/document/types';

/** 常用封装几何库（mm） */
export const FOOTPRINT_GEOMETRY: Record<string, FootprintGeometry> = {
  '0402': { footprintId: '0402', bodyWidthMm: 1.0, bodyHeightMm: 0.5, courtyardWidthMm: 1.5, courtyardHeightMm: 0.9, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
  '0603': { footprintId: '0603', bodyWidthMm: 1.6, bodyHeightMm: 0.8, courtyardWidthMm: 2.2, courtyardHeightMm: 1.3, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOT-223': { footprintId: 'SOT-223', bodyWidthMm: 6.5, bodyHeightMm: 3.5, courtyardWidthMm: 8.0, courtyardHeightMm: 4.5, assemblyHeightMm: 1.8, padCount: 4, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOIC-8': { footprintId: 'SOIC-8', bodyWidthMm: 4.9, bodyHeightMm: 3.9, courtyardWidthMm: 6.0, courtyardHeightMm: 5.0, assemblyHeightMm: 1.75, padCount: 8, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'SOP-16': { footprintId: 'SOP-16', bodyWidthMm: 10.0, bodyHeightMm: 4.0, courtyardWidthMm: 11.0, courtyardHeightMm: 6.4, padCount: 16, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'LQFP-48': { footprintId: 'LQFP-48', bodyWidthMm: 7.0, bodyHeightMm: 7.0, courtyardWidthMm: 9.2, courtyardHeightMm: 9.2, assemblyHeightMm: 1.6, padCount: 48, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'LQFP-100': { footprintId: 'LQFP-100', bodyWidthMm: 14.0, bodyHeightMm: 14.0, courtyardWidthMm: 16.2, courtyardHeightMm: 16.2, assemblyHeightMm: 1.6, padCount: 100, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'Module-44': { footprintId: 'Module-44', bodyWidthMm: 18.0, bodyHeightMm: 25.5, courtyardWidthMm: 19.0, courtyardHeightMm: 26.5, assemblyHeightMm: 3.1, padCount: 44, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'USB-C-16P': { footprintId: 'USB-C-16P', bodyWidthMm: 9.0, bodyHeightMm: 7.3, courtyardWidthMm: 10.5, courtyardHeightMm: 8.5, assemblyHeightMm: 3.2, padCount: 16, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'THT-2.54mm': { footprintId: 'THT-2.54mm', bodyWidthMm: 5.08, bodyHeightMm: 12.7, courtyardWidthMm: 6.0, courtyardHeightMm: 13.7, padCount: 10, rotationStep: 90, anchor: { x: 0, y: 0 } },
  'TSOT-23-8': { footprintId: 'TSOT-23-8', bodyWidthMm: 2.9, bodyHeightMm: 2.8, courtyardWidthMm: 4.2, courtyardHeightMm: 3.6, padCount: 8, rotationStep: 90, anchor: { x: 0, y: 0 } },
  '4018': { footprintId: '4018', bodyWidthMm: 4.0, bodyHeightMm: 4.0, courtyardWidthMm: 4.6, courtyardHeightMm: 4.6, assemblyHeightMm: 2.1, padCount: 2, rotationStep: 90, anchor: { x: 0, y: 0 } },
};

function geom(name: string): FootprintGeometry {
  return FOOTPRINT_GEOMETRY[name] ?? FOOTPRINT_GEOMETRY['SOIC-8'];
}

export interface MockComponent extends ComponentSearchResult {
  isOrg: boolean;
}

const cny = (amount: number) => ({ amount, currency: 'CNY' });

/** 供应商报价：真实搜索跳转链接（带型号），价格/库存为演示数据；正式版由 ezPLM 供应链 API 返回 */
export function supplierOffersFor(mpn: string, basePrice = 1): { vendor: string; price?: { amount: number; currency: string }; stock?: number; url: string }[] {
  const q = encodeURIComponent(mpn);
  return [
    { vendor: 'DigiKey', price: { amount: +(basePrice * 1.35).toFixed(2), currency: 'CNY' }, stock: 12500, url: `https://www.digikey.cn/zh/products/result?keywords=${q}` },
    { vendor: 'Mouser', price: { amount: +(basePrice * 1.42).toFixed(2), currency: 'CNY' }, stock: 8300, url: `https://www.mouser.cn/c/?q=${q}` },
    { vendor: 'CECPORT', price: { amount: +(basePrice * 1.1).toFixed(2), currency: 'CNY' }, stock: 3200, url: `https://www.cecport.com/search?keyword=${q}` },
  ];
}

export const MOCK_COMPONENTS: MockComponent[] = [
  // MCU
  { componentId: 'stm32f103', mpn: 'STM32F103C8T6', manufacturer: 'ST', category: 'mcu', defaultFootprintName: 'LQFP-48', family: 'STM32F1', description: 'ARM Cortex-M3 72MHz 64KB Flash', unitPrice: cny(8.5), pins: 48,
    attributes: { core: 'Cortex-M3', freq: '72MHz', flash: '64KB', ram: '20KB' },
    productUrl: 'https://www.st.com/en/microcontrollers-microprocessors/stm32f103c8.html',
    datasheetUrl: 'https://www.st.com/resource/en/datasheet/stm32f103c8.pdf',
    coreParams: { 内核: 'ARM Cortex-M3', 主频: '72MHz', Flash: '64KB', RAM: '20KB', 工作电压: '2.0-3.6V', GPIO: '37', 定时器: '4×16bit', 通信: '2×SPI/2×I2C/3×USART', ADC: '2×12bit 10ch', 工作温度: '-40~+85°C' },
    isOrg: true },
  { componentId: 'stm32f407', mpn: 'STM32F407VET6', manufacturer: 'ST', category: 'mcu', defaultFootprintName: 'LQFP-100', family: 'STM32F4', description: 'ARM Cortex-M4 168MHz 512KB Flash', unitPrice: cny(28.0), pins: 100, attributes: { core: 'Cortex-M4F', freq: '168MHz', flash: '512KB' }, isOrg: true },
  { componentId: 'esp32s3', mpn: 'ESP32-S3-WROOM-1', manufacturer: 'Espressif', category: 'mcu', defaultFootprintName: 'Module-44', family: 'ESP32', description: 'Wi-Fi+BLE5 双核Xtensa 240MHz', unitPrice: cny(15.8), pins: 44, attributes: { core: 'Xtensa LX7', freq: '240MHz', wireless: 'Wi-Fi+BLE5' }, isOrg: false },
  { componentId: 'gd32f303', mpn: 'GD32F303CCT6', manufacturer: 'GigaDevice', category: 'mcu', defaultFootprintName: 'LQFP-48', family: 'GD32F3', description: 'ARM Cortex-M4 120MHz 256KB Flash', unitPrice: cny(6.2), pins: 48, attributes: { core: 'Cortex-M4', freq: '120MHz' }, isOrg: false },
  // Power
  { componentId: 'lm1117', mpn: 'LM1117-3.3', manufacturer: 'TI', category: 'power', defaultFootprintName: 'SOT-223', family: 'LDO', description: '3.3V 800mA 低压差线性稳压器', unitPrice: cny(0.85), pins: 4, attributes: { vout: '3.3V', iout: '800mA' }, isOrg: true },
  { componentId: 'tps5430', mpn: 'TPS5430DDAR', manufacturer: 'TI', category: 'power', defaultFootprintName: 'SOIC-8', family: 'Buck', description: '5.5-36V输入 3A同步降压', unitPrice: cny(5.2), pins: 8, attributes: { vin: '5.5-36V', iout: '3A' }, isOrg: true },
  { componentId: 'ams1117', mpn: 'AMS1117-3.3', manufacturer: 'AMS', category: 'power', defaultFootprintName: 'SOT-223', family: 'LDO', description: '3.3V 1A 低压差线性稳压器', unitPrice: cny(0.35), pins: 4, attributes: { vout: '3.3V', iout: '1A' }, isOrg: false },
  { componentId: 'mp2315', mpn: 'MP2315GJ-Z', manufacturer: 'MPS', category: 'power', defaultFootprintName: 'TSOT-23-8', family: 'Buck', description: '4.5-24V 3A 同步降压转换器', unitPrice: cny(3.8), pins: 8, attributes: { vin: '4.5-24V', iout: '3A' }, isOrg: false },
  // Passive
  { componentId: 'cap100nf', mpn: 'CL10B104KB8NNNC', manufacturer: 'Samsung', category: 'passive', defaultFootprintName: '0402', family: 'MLCC', description: '100nF 50V X7R 陶瓷贴片电容', unitPrice: cny(0.02), pins: 2, attributes: { cap: '100nF', voltage: '50V' }, isOrg: true },
  { componentId: 'res10k', mpn: 'RC0402FR-0710KL', manufacturer: 'Yageo', category: 'passive', defaultFootprintName: '0402', family: 'Resistor', description: '10KΩ ±1% 1/16W 贴片电阻', unitPrice: cny(0.008), pins: 2, attributes: { resistance: '10KΩ', tolerance: '1%' }, isOrg: true },
  { componentId: 'ind4u7', mpn: 'SWPA4018S4R7MT', manufacturer: 'Sunlord', category: 'passive', defaultFootprintName: '4018', family: 'Inductor', description: '4.7μH 2.1A 功率电感', unitPrice: cny(0.45), pins: 2, attributes: { inductance: '4.7μH', current: '2.1A' }, isOrg: true },
  // Connector
  { componentId: 'usbc', mpn: 'TYPE-C-31-M-12', manufacturer: 'Korean Hroparts', category: 'connector', defaultFootprintName: 'USB-C-16P', family: 'USB-C', description: 'USB Type-C 母座 16Pin SMD', unitPrice: cny(1.2), pins: 16, attributes: { type: 'USB-C', mount: 'SMD' }, isOrg: true },
  { componentId: 'header2x5', mpn: 'PZ254V-12-05P2', manufacturer: 'Ckmtw', category: 'connector', defaultFootprintName: 'THT-2.54mm', family: 'Pin Header', description: '2.54mm 2x5P 直插排针', unitPrice: cny(0.3), pins: 10, attributes: { pitch: '2.54mm' }, isOrg: true },
  // IC
  { componentId: 'ch340', mpn: 'CH340G', manufacturer: 'WCH', category: 'ic', defaultFootprintName: 'SOP-16', family: 'USB-UART', description: 'USB转串口桥接芯片', unitPrice: cny(2.8), pins: 16, attributes: { interface: 'USB→UART' }, isOrg: true },
  { componentId: 'w25q64', mpn: 'W25Q64JVSIQ', manufacturer: 'Winbond', category: 'ic', defaultFootprintName: 'SOIC-8', family: 'NOR Flash', description: '64Mbit SPI NOR Flash', unitPrice: cny(3.5), pins: 8, attributes: { capacity: '64Mbit', interface: 'SPI' }, isOrg: false },
  { componentId: 'tja1050', mpn: 'TJA1050T/CM', manufacturer: 'NXP', category: 'ic', defaultFootprintName: 'SOIC-8', family: 'CAN Transceiver', description: '高速CAN总线收发器', unitPrice: cny(4.1), pins: 8, attributes: { speed: '1Mbps' }, isOrg: false },
];

/** 把 mpn 映射到封装几何 */
export function geometryFor(footprintName: string): FootprintGeometry {
  return geom(footprintName);
}

/* 封装库（分类浏览） */
export const FOOTPRINT_LIBRARY: FootprintOption[] = [
  { footprintId: 'fp0402', name: '0402', geometry: geom('0402'), confidence: 1, source: 'KiCad/Resistor_SMD', category: 'smd_chip' },
  { footprintId: 'fp0603', name: '0603', geometry: geom('0603'), confidence: 1, source: 'KiCad/Resistor_SMD', category: 'smd_chip' },
  { footprintId: 'fpsot223', name: 'SOT-223', geometry: geom('SOT-223'), confidence: 1, source: 'KiCad/Package_TO_SOT_SMD', category: 'sot' },
  { footprintId: 'fpsoic8', name: 'SOIC-8', geometry: geom('SOIC-8'), confidence: 1, source: 'KiCad/Package_SO', category: 'soic' },
  { footprintId: 'fpsop16', name: 'SOP-16', geometry: geom('SOP-16'), confidence: 1, source: 'KiCad/Package_SO', category: 'soic' },
  { footprintId: 'fplqfp48', name: 'LQFP-48', geometry: geom('LQFP-48'), confidence: 1, source: 'KiCad/Package_QFP', category: 'qfp' },
  { footprintId: 'fplqfp100', name: 'LQFP-100', geometry: geom('LQFP-100'), confidence: 1, source: 'KiCad/Package_QFP', category: 'qfp' },
  { footprintId: 'fpusbc', name: 'USB-C-16P', geometry: geom('USB-C-16P'), confidence: 0.9, source: 'KiCad/Connector_USB', category: 'conn' },
  { footprintId: 'fpheader', name: 'THT-2.54mm', geometry: geom('THT-2.54mm'), confidence: 1, source: 'KiCad/Connector_PinHeader', category: 'tht' },
];

export const FOOTPRINT_CATEGORIES = [
  { id: 'smd_chip', name: '贴片阻容', icon: '▭' },
  { id: 'sot', name: '小外形晶体管', icon: '◮' },
  { id: 'soic', name: 'SOIC/SOP', icon: '▤' },
  { id: 'qfp', name: 'QFP/QFN', icon: '▦' },
  { id: 'tht', name: '直插类', icon: '⫧' },
  { id: 'conn', name: '连接器封装', icon: '⊟' },
];

export const ALTERNATIVES: Record<string, ComponentAlternative[]> = {
  'STM32F103C8T6': [
    { mpn: 'GD32F103C8T6', manufacturer: 'GigaDevice', note: '引脚兼容，主频更高(108MHz)，价格约低30%', channel: '立创商城/淘宝', footprint: 'LQFP-48', description: 'Cortex-M3 108MHz 64KB Flash' },
    { mpn: 'CH32F103C8T6', manufacturer: 'WCH', note: '引脚兼容，国产替代，价格约低50%', channel: '立创商城', footprint: 'LQFP-48', description: 'Cortex-M3 72MHz 64KB Flash' },
    { mpn: 'APM32F103C8T6', manufacturer: 'Geehy', note: '引脚兼容，工业级', channel: '立创商城/得捷', footprint: 'LQFP-48', description: 'Cortex-M3 96MHz 工业级' },
  ],
  'LM1117-3.3': [
    { mpn: 'AMS1117-3.3', manufacturer: 'AMS', note: '直接替代，价格约低60%', channel: '立创商城' },
    { mpn: 'ME6211C33', manufacturer: 'Microne', note: '低静态电流，适合电池供电', channel: '立创商城' },
  ],
  'CH340G': [
    { mpn: 'CP2102N', manufacturer: 'Silicon Labs', note: '更稳定的驱动，免晶振', channel: '得捷/贸泽' },
    { mpn: 'CH340C', manufacturer: 'WCH', note: '内置晶振版本，省一个晶振', channel: '立创商城' },
  ],
  'ESP32-S3-WROOM-1': [
    { mpn: 'ESP32-C3-WROOM-02', manufacturer: 'Espressif', note: 'RISC-V单核，成本更低', channel: '立创商城/官方' },
  ],
  'W25Q64JVSIQ': [
    { mpn: 'GD25Q64C', manufacturer: 'GigaDevice', note: '引脚兼容，国产替代', channel: '立创商城' },
    { mpn: 'BY25Q64AS', manufacturer: 'Boya', note: '引脚兼容，价格更低', channel: '立创商城' },
  ],
};

export const SUBCIRCUITS: Record<ComponentCategory, PeripheralCircuitRecommendation[]> = {
  mcu: [
    { name: '时钟电路', parts: '8MHz/16MHz晶振 + 2×22pF负载电容', why: '为MCU提供精确时钟源' },
    { name: '复位电路', parts: '10KΩ上拉电阻 + 100nF电容 + 复位按键', why: '上电复位与手动复位', quickAddComponentId: 'res10k' },
    { name: '去耦网络', parts: '每个VDD引脚100nF + 整体10μF钽电容', why: '抑制电源噪声', quickAddComponentId: 'cap100nf' },
    { name: '调试接口', parts: 'SWD排针(2.54mm 2×5P)', why: '程序烧录与在线调试', quickAddComponentId: 'header2x5' },
    { name: 'BOOT配置', parts: 'BOOT0下拉10KΩ电阻', why: '选择启动模式', quickAddComponentId: 'res10k' },
  ],
  power: [
    { name: '输入保护', parts: '自恢复保险丝 + TVS二极管', why: '过流过压保护' },
    { name: '输入滤波', parts: '10μF + 100nF 并联输入电容', why: '抑制输入纹波', quickAddComponentId: 'cap100nf' },
    { name: '输出滤波', parts: '22μF输出电容 + 磁珠', why: '降低输出噪声' },
  ],
  connector: [
    { name: 'ESD防护', parts: 'USBLC6-2SC6 ESD保护芯片', why: '静电防护，保护数据线' },
    { name: 'CC配置', parts: '2×5.1KΩ CC下拉电阻 (USB-C)', why: 'USB-C设备模式识别', quickAddComponentId: 'res10k' },
  ],
  ic: [
    { name: '去耦电容', parts: '每个电源引脚就近100nF', why: '高频去耦', quickAddComponentId: 'cap100nf' },
    { name: 'SPI上拉', parts: 'CS引脚10KΩ上拉 (Flash类)', why: '防止总线悬空', quickAddComponentId: 'res10k' },
  ],
  passive: [],
};
