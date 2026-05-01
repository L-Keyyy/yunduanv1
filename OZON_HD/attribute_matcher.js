/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 属性匹配模块
 * 将抓取的商品特征（文本格式）映射为 OZON API 所需的属性 ID + 字典值 ID
 */

/**
 * 标准化字符串用于匹配
 */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[,.:;!?]/g, '');
}

/**
 * 构建属性名称到属性定义的映射表
 * @param {Array} ozonAttributes - /v1/description-category/attribute 返回的 result 数组
 * @returns {Map<normalizedName, attributeDef>}
 */
function buildAttributeNameMap(ozonAttributes) {
  const map = new Map();
  for (const attr of ozonAttributes) {
    map.set(norm(attr.name), attr);
  }
  return map;
}

/**
 * 在字典值列表中查找匹配项
 * @param {Array} dictValues - 字典值数组 [{id, value, info}, ...]
 * @param {string} textValue - 要匹配的文本值
 * @returns {{id: number, value: string} | null}
 */
function findDictValue(dictValues, textValue) {
  const normText = norm(textValue);

  // 精确匹配
  for (const dv of dictValues) {
    if (norm(dv.value) === normText) {
      return dv;
    }
  }

  // 包含匹配
  for (const dv of dictValues) {
    const normDv = norm(dv.value);
    if (normDv.includes(normText) || normText.includes(normDv)) {
      return dv;
    }
  }

  return null;
}

/**
 * 俄语特征名称与 OZON 属性名称的手工映射补充表
 * 用于处理名称不完全一致的情况
 */
const MANUAL_NAME_MAP = {
  'артикул': null, // 不映射，用作 offer_id 的一部分
  'тип': 'тип',
  'страна-изготовитель': 'страна-изготовитель',
  'материал': 'материал',
  'высота см': 'высота',
  'ширина см': 'ширина',
  'глубина см': 'глубина',
  'объем главного отделения л': 'объем',
  'материал подкладки': 'материал подкладки',
  'вид замка на чемодане': 'вид замка',
  'вид принта': 'вид принта',
  'количество внутренних отделений': 'количество отделений',
  'материал фурнитуры': 'материал фурнитуры',
  'цвет': 'цвет',
  'целевая аудитория': 'целевая аудитория',
  'пол': 'пол',
  'коллекция': 'коллекция',
  'размер чемодана': 'размер',
  'ручная кладь': 'ручная кладь',
  'число колес': 'число колес',
  'специальные отделения': 'специальные отделения',
  'ручки': 'ручки',
  'тип застежки': 'тип застежки',
  'вес кг': null, // 不映射到属性，用于 weight 字段
  'упаковка': 'упаковка',
  'гарантийный срок': 'гарантийный срок',
  'особенности конструкции сумки': 'особенности',
};

/**
 * 将抓取的特征列表与 OZON 属性进行匹配
 * @param {Array} scrapedChars - 抓取的 characteristics 数组
 * @param {Array} ozonAttributes - OZON 返回的属性定义数组
 * @param {Function} getDictValues - 异步函数 (attributeId) => dictValues[]
 * @returns {Promise<{matched: Array, unmatched: Array, ozonFormat: Array}>}
 */
async function matchAttributes(scrapedChars, ozonAttributes, getDictValues) {
  const nameMap = buildAttributeNameMap(ozonAttributes);
  const matched = [];
  const unmatched = [];
  const ozonFormat = [];

  // 需要跳过的特征（已在其他字段中处理）
  const skipNames = new Set(['артикул', 'вес кг', 'высота см', 'ширина см', 'глубина см']);

  for (const char of scrapedChars) {
    const normName = norm(char.name);

    if (skipNames.has(normName)) {
      matched.push({ scraped: char, note: '已在其他字段处理，跳过' });
      continue;
    }

    // 尝试直接名称匹配
    let ozonAttr = nameMap.get(normName);

    // 尝试去掉单位后匹配
    if (!ozonAttr) {
      const nameWithoutUnit = normName.replace(/\s*(см|кг|л|мм|г)\s*$/, '').trim();
      ozonAttr = nameMap.get(nameWithoutUnit);
    }

    // 尝试手工映射表
    if (!ozonAttr && MANUAL_NAME_MAP[normName] !== undefined) {
      const mappedName = MANUAL_NAME_MAP[normName];
      if (mappedName === null) {
        matched.push({ scraped: char, note: '手工映射：跳过' });
        continue;
      }
      ozonAttr = nameMap.get(norm(mappedName));
    }

    // 尝试模糊匹配（包含关系）
    if (!ozonAttr) {
      for (const [key, attr] of nameMap) {
        if (key.includes(normName) || normName.includes(key)) {
          ozonAttr = attr;
          break;
        }
      }
    }

    if (!ozonAttr) {
      unmatched.push(char);
      continue;
    }

    // 构建 OZON 格式的属性值
    const values = char.values || [char.valueText];
    const ozonValues = [];

    for (const val of values) {
      if (ozonAttr.dictionary_id && ozonAttr.dictionary_id > 0) {
        // 需要从字典中查找
        const dictValues = await getDictValues(ozonAttr.id);
        const dictMatch = findDictValue(dictValues, val);
        if (dictMatch) {
          ozonValues.push({
            dictionary_value_id: dictMatch.id,
            value: dictMatch.value,
          });
        } else {
          // 字典中未找到，尝试作为自定义值提交
          ozonValues.push({
            dictionary_value_id: 0,
            value: val,
          });
        }
      } else {
        ozonValues.push({
          dictionary_value_id: 0,
          value: val,
        });
      }
    }

    if (ozonValues.length > 0) {
      ozonFormat.push({
        id: ozonAttr.id,
        complex_id: 0,
        values: ozonValues,
      });
      matched.push({
        scraped: char,
        ozonAttr: { id: ozonAttr.id, name: ozonAttr.name },
        values: ozonValues,
      });
    }
  }

  return { matched, unmatched, ozonFormat };
}

module.exports = { matchAttributes, buildAttributeNameMap, findDictValue };
