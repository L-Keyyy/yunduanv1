export type OzonRequirementLevel = "required" | "conditional" | "recommended";

export type OzonAttributeNode = {
  id: string;
  label: string;
  ozonCode?: string;
  valueType: "string" | "number" | "boolean" | "enum" | "media" | "dimension" | "rich_text";
  requirement: OzonRequirementLevel;
  source: "listing_base" | "category_api" | "special_rule";
  aiHint: string;
  humanReview: boolean;
  children?: OzonAttributeNode[];
};

export type SourceProductModule = {
  id: string;
  label: string;
  content: string;
  confidence: number;
};

export type OzonMappedFeature = {
  attributeId: string;
  label: string;
  value: string;
  confidence: number;
  sourceModuleIds: string[];
  status: "auto" | "review" | "missing" | "special";
  reason: string;
};

export const ozonListingBaseFields: OzonAttributeNode[] = [
  {
    id: "category_type",
    label: "Ozon 描述类目 / Type ID",
    ozonCode: "description_category_id/type_id",
    valueType: "enum",
    requirement: "required",
    source: "category_api",
    aiHint: "从 Ozon 类目同步表选择末级 description_category_id + type_id。",
    humanReview: true,
  },
  {
    id: "offer_id",
    label: "卖家 SKU / offer_id",
    ozonCode: "offer_id",
    valueType: "string",
    requirement: "required",
    source: "listing_base",
    aiHint: "没有货号时用平台规则生成稳定 SKU，例如来源平台 + 类目缩写 + 时间戳。",
    humanReview: true,
  },
  {
    id: "name",
    label: "商品名称",
    ozonCode: "name",
    valueType: "string",
    requirement: "required",
    source: "listing_base",
    aiHint: "把来源标题改成俄语/英语可读标题，保留品牌、品类、规格、核心卖点，去掉营销噪音。",
    humanReview: true,
  },
  {
    id: "short_description",
    label: "商品简述 / 简介",
    ozonCode: "description",
    valueType: "rich_text",
    requirement: "recommended",
    source: "listing_base",
    aiHint: "从详情页描述、卖点和规格里提炼简短说明，优先保留真实功能、材质、适用场景，不写夸张承诺。",
    humanReview: true,
  },
  {
    id: "tags",
    label: "标签 / 关键词",
    ozonCode: "tags/keywords",
    valueType: "string",
    requirement: "recommended",
    source: "listing_base",
    aiHint: "从来源标签、标题关键词、适用场景和核心卖点里生成，作为运营检索和人工复核字段。",
    humanReview: true,
  },
  {
    id: "brand",
    label: "品牌",
    ozonCode: "brand",
    valueType: "string",
    requirement: "required",
    source: "listing_base",
    aiHint: "按当前上架规则统一填写“无”，不从供应商标题或参数中提取品牌。",
    humanReview: true,
  },
  {
    id: "price",
    label: "当前价格",
    ozonCode: "price",
    valueType: "number",
    requirement: "required",
    source: "listing_base",
    aiHint: "从采购价、汇率、物流、佣金、利润规则计算；不让模型直接猜最终售价。",
    humanReview: true,
  },
  {
    id: "old_price",
    label: "折扣前价格",
    ozonCode: "old_price",
    valueType: "number",
    requirement: "recommended",
    source: "listing_base",
    aiHint: "营销展示用原价，需符合平台规则和店铺定价策略。",
    humanReview: true,
  },
  {
    id: "min_price",
    label: "最低价格",
    ozonCode: "min_price",
    valueType: "number",
    requirement: "recommended",
    source: "listing_base",
    aiHint: "价格策略字段，通常由利润和促销规则计算。",
    humanReview: true,
  },
  {
    id: "cost_price",
    label: "成本 / 采购价",
    valueType: "number",
    requirement: "recommended",
    source: "listing_base",
    aiHint: "由来源商品抓取价格自动填写，仅用于内部定价，不进入 Ozon 上货 JSON。",
    humanReview: true,
  },
  {
    id: "currency_code",
    label: "币种",
    ozonCode: "currency_code",
    valueType: "enum",
    requirement: "required",
    source: "listing_base",
    aiHint: "按店铺/上架策略填写币种。",
    humanReview: true,
  },
  {
    id: "barcode",
    label: "条码",
    ozonCode: "barcode",
    valueType: "string",
    requirement: "conditional",
    source: "listing_base",
    aiHint: "有源条码时填写；缺失时按店铺和类目规则决定是否留空或人工补充。",
    humanReview: true,
  },
  {
    id: "images",
    label: "商品图片",
    ozonCode: "primary_image/images",
    valueType: "media",
    requirement: "required",
    source: "listing_base",
    aiHint: "主图、细节图、场景图按 Ozon 图片规范排序；低清、带中文水印、二维码要标记处理。",
    humanReview: true,
  },
  {
    id: "dimensions",
    label: "包装尺寸与重量",
    valueType: "dimension",
    requirement: "required",
    source: "listing_base",
    aiHint: "物流字段缺失会影响上架和运费，缺任一项都进入人工复核。",
    humanReview: true,
    children: [
      {
        id: "weight",
        label: "包装重量",
        ozonCode: "weight",
        valueType: "number",
        requirement: "required",
        source: "listing_base",
        aiHint: "优先读取供应商包装重量，单位转换成 Ozon 要求单位。",
        humanReview: true,
      },
      {
        id: "weight_unit",
        label: "重量单位",
        ozonCode: "weight_unit",
        valueType: "enum",
        requirement: "required",
        source: "listing_base",
        aiHint: "和包装重量一起上传，默认按本地上架模块使用 g。",
        humanReview: true,
      },
      {
        id: "depth",
        label: "包装长",
        ozonCode: "depth",
        valueType: "number",
        requirement: "required",
        source: "listing_base",
        aiHint: "从包装规格或人工录入获得。",
        humanReview: true,
      },
      {
        id: "width",
        label: "包装宽",
        ozonCode: "width",
        valueType: "number",
        requirement: "required",
        source: "listing_base",
        aiHint: "从包装规格或人工录入获得。",
        humanReview: true,
      },
      {
        id: "height",
        label: "包装高",
        ozonCode: "height",
        valueType: "number",
        requirement: "required",
        source: "listing_base",
        aiHint: "从包装规格或人工录入获得。",
        humanReview: true,
      },
      {
        id: "dimension_unit",
        label: "尺寸单位",
        ozonCode: "dimension_unit",
        valueType: "enum",
        requirement: "required",
        source: "listing_base",
        aiHint: "和包装长宽高一起上传，默认按本地上架模块使用 mm。",
        humanReview: true,
      },
    ],
  },
];

export const sampleSourceModules: SourceProductModule[] = [
  {
    id: "title",
    label: "抓取模块：标题",
    content: "淘宝标题、SKU 名称、规格词会先进这里。真实接入后由采集器/OCR/详情页解析写入。",
    confidence: 0.92,
  },
  {
    id: "specs",
    label: "抓取模块：规格参数",
    content: "材质、尺寸、容量、功率、颜色、型号等结构化参数会作为 DeepSeek 的主要依据。",
    confidence: 0.86,
  },
  {
    id: "images",
    label: "抓取模块：图片/OCR",
    content: "包装图、铭牌、尺码表、成分表由视觉模型或 OCR 抽取，再交给 DeepSeek 做属性匹配。",
    confidence: 0.74,
  },
];

export const deepseekMappingContract = {
  input: {
    sourceModules: "sourceModules[]",
    ozonCategoryTree: "db.ozonCategory + db.ozonAttribute + db.ozonAttributeValue",
  },
  output: {
    mappedFeatures: "mappedFeatures[]",
  },
  hardRules: [
    "只允许输出同步表里存在的 Ozon attribute id。",
    "isRequired=true 的属性没有可靠来源时必须标记 missing，不能编造。",
    "dictionaryId 存在时必须优先匹配 OzonAttributeValue 里的允许值；缓存不足时用 /v1/description-category/attribute/values/search 搜索官方参考值。",
    "税率、认证、危险品、条码、成分等高风险字段必须进入人工复核。",
    "每个字段必须带 sourceModuleIds、confidence、reason，方便人工追溯。",
  ],
};
