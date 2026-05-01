/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 分类树搜索模块
 * 根据商品面包屑和类型名称，在 OZON 分类树中找到匹配的
 * description_category_id 和 type_id
 */

/**
 * 扁平化遍历分类树，收集所有叶子节点（type 级别）的完整路径信息
 * @param {object} treeData - getCategoryTree() 的返回值
 * @returns {Array<{description_category_id, type_id, type_name, path: string[]}>}
 */
function flattenTree(treeData) {
  const leaves = [];

  function walk(nodes, parentCatId, pathNames) {
    for (const node of nodes) {
      if (node.type_id !== undefined) {
        leaves.push({
          description_category_id: parentCatId,
          type_id: node.type_id,
          type_name: node.type_name || '',
          disabled: node.disabled || false,
          path: [...pathNames, node.type_name || ''],
        });
      } else {
        const catId = node.description_category_id || parentCatId;
        const name = node.category_name || '';
        walk(node.children || [], catId, [...pathNames, name]);
      }
    }
  }

  walk(treeData.result || [], null, []);
  return leaves;
}

/**
 * 标准化字符串用于模糊匹配：小写、去除多余空格
 */
function normalize(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * 在分类树中搜索最佳匹配
 * @param {object} treeData - API 返回的分类树
 * @param {string[]} breadcrumbNames - 从商品页面抓取的面包屑名称列表
 * @param {string} typeName - 商品类型名称（如 "Чемодан"）
 * @returns {{description_category_id, type_id, type_name, path, score} | null}
 */
function findBestMatch(treeData, breadcrumbNames, typeName) {
  const leaves = flattenTree(treeData);
  const normType = normalize(typeName);
  const normBreadcrumbs = breadcrumbNames.map(normalize);

  let bestMatch = null;
  let bestScore = -1;

  for (const leaf of leaves) {
    if (leaf.disabled) continue;

    let score = 0;
    const normLeafType = normalize(leaf.type_name);
    const normPath = leaf.path.map(normalize);
    if (!normType && normBreadcrumbs.length === 0) {
      continue;
    }
    if (!normType) {
      // No explicit type on the page: rely on breadcrumb matching only.
    } else

    // 类型名称精确匹配 +20 分
    if (normLeafType === normType) {
      score += 20;
    }
    // 类型名称包含匹配 +10 分
    else if (normLeafType.includes(normType) || normType.includes(normLeafType)) {
      score += 10;
    } else {
      continue; // 类型名不匹配，跳过
    }

    // 面包屑路径匹配：每个面包屑在路径中找到 +5 分
    for (const bc of normBreadcrumbs) {
      for (const pp of normPath) {
        if (pp === bc) {
          score += 5;
          break;
        }
        if (pp.includes(bc) || bc.includes(pp)) {
          score += 3;
          break;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...leaf, score };
    }
  }

  return bestMatch;
}

/**
 * 按关键词搜索分类树，返回所有匹配的叶子节点（用于调试/手动选择）
 */
function searchByKeyword(treeData, keyword) {
  const leaves = flattenTree(treeData);
  const normKw = normalize(keyword);
  return leaves.filter((leaf) => {
    if (leaf.disabled) return false;
    const fullPath = leaf.path.map(normalize).join(' ');
    return fullPath.includes(normKw) || normalize(leaf.type_name).includes(normKw);
  });
}

module.exports = { flattenTree, findBestMatch, searchByKeyword };
