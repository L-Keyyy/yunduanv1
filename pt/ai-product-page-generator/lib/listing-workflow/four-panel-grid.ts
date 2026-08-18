import sharp from "sharp";

export type FourPanelCrop = {
  index: number;
  label: "左上" | "右上" | "左下" | "右下";
  left: number;
  top: number;
  width: number;
  height: number;
  buffer: Buffer;
};

export type FourPanelGridResult = {
  sourceWidth: number;
  sourceHeight: number;
  mode: "separator" | "geometric-fallback";
  crops: FourPanelCrop[];
  warnings: string[];
};

type Band = { start: number; end: number; score: number };
type Bounds = { start: number; end: number };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function isNearWhite(r: number, g: number, b: number) {
  return (
    r >= 242 &&
    g >= 242 &&
    b >= 242 &&
    Math.max(r, g, b) - Math.min(r, g, b) <= 14
  );
}

function rowWhiteScores(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
) {
  const scores = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    let white = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (isNearWhite(data[offset], data[offset + 1], data[offset + 2])) {
        white += 1;
      }
    }
    scores[y] = white / width;
  }
  return scores;
}

function columnWhiteScores(
  data: Buffer,
  width: number,
  channels: number,
  top: number,
  bottom: number,
) {
  const sampleHeight = Math.max(1, bottom - top + 1);
  const scores = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x += 1) {
    let white = 0;
    for (let y = top; y <= bottom; y += 1) {
      const offset = (y * width + x) * channels;
      if (isNearWhite(data[offset], data[offset + 1], data[offset + 2])) {
        white += 1;
      }
    }
    scores[x] = white / sampleHeight;
  }
  return scores;
}

function axisContentBounds(scores: number[]): Bounds {
  const maximum = scores.length - 1;
  let start = scores.findIndex((score) => score < 0.985);
  if (start < 0) start = 0;
  let end = maximum;
  while (end > start && scores[end] >= 0.985) end -= 1;
  return { start, end };
}

function findCentralWhiteBand(scores: number[], threshold = 0.965): Band | null {
  const searchStart = clamp(scores.length * 0.34, 0, scores.length - 1);
  const searchEnd = clamp(scores.length * 0.66, searchStart, scores.length - 1);

  const collect = (minimumScore: number) => {
    const bands: Band[] = [];
    let start = -1;
    let total = 0;
    for (let index = searchStart; index <= searchEnd + 1; index += 1) {
      const score = index <= searchEnd ? scores[index] : -1;
      if (score >= minimumScore) {
        if (start < 0) {
          start = index;
          total = 0;
        }
        total += score;
      } else if (start >= 0) {
        const end = index - 1;
        const width = end - start + 1;
        if (width <= Math.max(48, Math.round(scores.length * 0.08))) {
          bands.push({ start, end, score: total / width });
        }
        start = -1;
        total = 0;
      }
    }
    return bands;
  };

  let bands = collect(threshold);
  if (!bands.length) {
    const maximum = Math.max(...scores.slice(searchStart, searchEnd + 1));
    if (maximum < 0.88) return null;
    bands = collect(Math.max(0.86, maximum - 0.025));
  }

  const center = scores.length / 2;
  return (
    bands.sort((a, b) => {
      const aCenter = (a.start + a.end) / 2;
      const bCenter = (b.start + b.end) / 2;
      const aRank = a.score - Math.abs(aCenter - center) / scores.length;
      const bRank = b.score - Math.abs(bCenter - center) / scores.length;
      return bRank - aRank;
    })[0] ?? null
  );
}

function cropRect(
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function geometricFallback(width: number, height: number) {
  const marginX = clamp(width * 0.012, 2, 40);
  const marginY = clamp(height * 0.009, 2, 40);
  const gapX = clamp(width * 0.012, 6, 36);
  const gapY = clamp(height * 0.009, 6, 36);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);
  const xStart = centerX - Math.floor(gapX / 2);
  const xEnd = centerX + Math.ceil(gapX / 2);
  const yStart = centerY - Math.floor(gapY / 2);
  const yEnd = centerY + Math.ceil(gapY / 2);
  return [
    cropRect(marginX, marginY, xStart - 1, yStart - 1),
    cropRect(xEnd, marginY, width - marginX - 1, yStart - 1),
    cropRect(marginX, yEnd, xStart - 1, height - marginY - 1),
    cropRect(xEnd, yEnd, width - marginX - 1, height - marginY - 1),
  ];
}

export async function extractFourPanelGrid(
  inputPath: string,
): Promise<FourPanelGridResult> {
  const sourceMetadata = await sharp(inputPath).metadata();
  const originalWidth = sourceMetadata.width ?? 0;
  const originalHeight = sourceMetadata.height ?? 0;
  const warnings: string[] = [];
  let source: string | Buffer = inputPath;

  // 豆包新版页面偶尔只暴露 288×384 的预览图。原图捕获作为主路径，
  // 这里保留高质量 Lanczos 放大兜底，保证已经生成的任务也能继续裁剪。
  if (originalWidth < 600 || originalHeight < 800) {
    const scale = Math.max(1200 / Math.max(originalWidth, 1), 1600 / Math.max(originalHeight, 1));
    const width = Math.max(1200, Math.round(originalWidth * scale));
    const height = Math.max(1600, Math.round(originalHeight * scale));
    source = await sharp(inputPath)
      .resize(width, height, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();
    warnings.push(
      `豆包页面返回 ${originalWidth}×${originalHeight} 预览图，已自动高清化到 ${width}×${height} 后裁剪。`,
    );
  }

  const { data, info } = await sharp(source)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rows = rowWhiteScores(data, width, height, channels);
  const outerY = axisContentBounds(rows);
  const horizontal = findCentralWhiteBand(rows);
  let mode: FourPanelGridResult["mode"] = "separator";
  let rectangles: Array<{ left: number; top: number; width: number; height: number }>;

  if (horizontal) {
    const topColumns = columnWhiteScores(
      data,
      width,
      channels,
      outerY.start,
      Math.max(outerY.start, horizontal.start - 1),
    );
    const bottomColumns = columnWhiteScores(
      data,
      width,
      channels,
      Math.min(outerY.end, horizontal.end + 1),
      outerY.end,
    );
    const outerX = axisContentBounds(
      topColumns.map((score, index) => Math.min(score, bottomColumns[index])),
    );
    const topVertical = findCentralWhiteBand(topColumns);
    const bottomVertical = findCentralWhiteBand(bottomColumns);
    if (topVertical && bottomVertical) {
      rectangles = [
        cropRect(
          outerX.start,
          outerY.start,
          topVertical.start - 1,
          horizontal.start - 1,
        ),
        cropRect(
          topVertical.end + 1,
          outerY.start,
          outerX.end,
          horizontal.start - 1,
        ),
        cropRect(
          outerX.start,
          horizontal.end + 1,
          bottomVertical.start - 1,
          outerY.end,
        ),
        cropRect(
          bottomVertical.end + 1,
          horizontal.end + 1,
          outerX.end,
          outerY.end,
        ),
      ];
    } else {
      mode = "geometric-fallback";
      warnings.push("纵向白色分隔带识别不完整，已按标准等分四宫格裁剪。");
      rectangles = geometricFallback(width, height);
    }
  } else {
    mode = "geometric-fallback";
    warnings.push("横向白色分隔带未识别，已按标准等分四宫格裁剪。");
    rectangles = geometricFallback(width, height);
  }

  if (
    rectangles.some(
      (rectangle) => rectangle.width < 240 || rectangle.height < 320,
    )
  ) {
    mode = "geometric-fallback";
    warnings.push("自动分隔结果尺寸异常，已回退到标准等分四宫格。");
    rectangles = geometricFallback(width, height);
  }

  const labels = ["左上", "右上", "左下", "右下"] as const;
  const crops = await Promise.all(
    rectangles.map(async (rectangle, index) => {
      const label = labels[index];
      if (!label) throw new Error(`四宫格裁剪序号异常：${index}`);
      return {
        index,
        label,
        ...rectangle,
        buffer: await sharp(source)
          .extract(rectangle)
          .png({ compressionLevel: 9 })
          .toBuffer(),
      };
    }),
  );

  return {
    sourceWidth: width,
    sourceHeight: height,
    mode,
    crops,
    warnings,
  };
}
