import { BEAD_PALETTE } from './beadPalette'

// ============================================================
// 拼豆图像量化核心模块
// 色彩空间：CIE OKLab（Björn Ottosson, 2020 公开学术论文）
// 量化策略：感知均匀空间最近邻 + 频度优先的颜色合并
// ============================================================

// 解析 hex 为 RGB 三元组
const parseHex = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
})

// 色板：预先计算每个色的 RGB 与 OKLab 坐标，避免运行时重复换算
const PALETTE = BEAD_PALETTE.map((entry) => {
  const rgb = parseHex(entry.hex)
  return { hex: entry.hex, name: entry.name, rgb, lab: toOklab(rgb) }
})

// sRGB 单通道 → 线性光（伽马解码）
function linearizeChannel(value) {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

// sRGB → OKLab（矩阵系数与三次根变换来自公开的 OKLab 色彩空间定义）
function toOklab({ r, g, b }) {
  const R = linearizeChannel(r)
  const G = linearizeChannel(g)
  const B = linearizeChannel(b)
  // 线性 sRGB → LMS
  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B
  // 非线性响应（立方根）
  const lCbrt = Math.cbrt(l)
  const mCbrt = Math.cbrt(m)
  const sCbrt = Math.cbrt(s)
  // LMS' → OKLab
  return {
    L: 0.2104542553 * lCbrt + 0.7936177850 * mCbrt - 0.0040720468 * sCbrt,
    A: 1.9779984951 * lCbrt - 2.4285922050 * mCbrt + 0.4505937099 * sCbrt,
    B: 0.0259040371 * lCbrt + 0.7827717662 * mCbrt - 0.8086757660 * sCbrt,
  }
}

// 输入色 → OKLab（带记忆化缓存，减少重复像素的换算开销）
const labCache = new Map()
function resolveLab(rgb) {
  const key = rgb.r * 65536 + rgb.g * 256 + rgb.b
  let cached = labCache.get(key)
  if (!cached) {
    cached = toOklab(rgb)
    labCache.set(key, cached)
  }
  return cached
}

// 两色在 OKLab 空间的欧氏距离（感知均匀，越近越相似）
export function colorDistance(rgbA, rgbB) {
  const A = resolveLab(rgbA)
  const B = resolveLab(rgbB)
  const dL = A.L - B.L
  const dA = A.A - B.A
  const dB = A.B - B.B
  return Math.sqrt(dL * dL + dA * dA + dB * dB)
}

// 在色板中查找与目标色最接近的色（线性扫描，色板规模小可接受）
export function findClosestColor(targetRgb) {
  const targetLab = resolveLab(targetRgb)
  let best = PALETTE[0]
  let bestDist = Infinity
  for (const bead of PALETTE) {
    const dL = targetLab.L - bead.lab.L
    const dA = targetLab.A - bead.lab.A
    const dB = targetLab.B - bead.lab.B
    const dist = dL * dL + dA * dA + dB * dB
    if (dist < bestDist) {
      bestDist = dist
      best = bead
      if (dist === 0) break // 精确命中，提前结束
    }
  }
  return best
}

// 统计网格中各色的出现次数
function tallyColors(grid) {
  const freq = new Map()
  for (const row of grid) {
    for (const cell of row) {
      if (cell) freq.set(cell.hex, (freq.get(cell.hex) || 0) + 1)
    }
  }
  return freq
}

// 将出现频次低于阈值距离内的颜色合并到更常用的颜色上
function clusterSimilarColors(grid, threshold) {
  const freq = tallyColors(grid)
  // 按频次降序排列，高频色优先作为"锚点"被保留
  const ranked = Array.from(freq.entries())
    .map(([hex, count]) => {
      const bead = PALETTE.find((c) => c.hex === hex)
      return bead ? { bead, count } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)

  const anchors = []
  const redirect = new Map()
  for (const { bead } of ranked) {
    let matched = null
    for (const anchor of anchors) {
      if (colorDistance(bead.rgb, anchor.rgb) < threshold) {
        matched = anchor
        break
      }
    }
    if (matched) {
      redirect.set(bead.hex, matched)
    } else {
      anchors.push(bead)
    }
  }

  const newFreq = new Map()
  for (const row of grid) {
    for (let idx = 0; idx < row.length; idx++) {
      const cell = row[idx]
      if (cell) {
        const replacement = redirect.get(cell.hex) || cell
        row[idx] = replacement
        newFreq.set(replacement.hex, (newFreq.get(replacement.hex) || 0) + 1)
      }
    }
  }
  return { grid, counts: newFreq }
}

// 限制最终使用的颜色种类：保留高频色，其余映射到最近的保留色
export function limitColors(grid, maxColors, mergeThreshold = 0) {
  if (mergeThreshold > 0) {
    const clustered = clusterSimilarColors(grid, mergeThreshold)
    grid = clustered.grid
  }

  const freq = tallyColors(grid)
  const ranked = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])
  if (ranked.length <= maxColors) {
    return { grid, counts: freq }
  }

  // 保留频次最高的 maxColors 种
  const keptHex = new Set(ranked.slice(0, maxColors).map(([hex]) => hex))
  const keptBeads = PALETTE.filter((c) => keptHex.has(c.hex))
  const redirect = new Map()

  for (const [hex] of ranked) {
    if (keptHex.has(hex)) continue
    const bead = PALETTE.find((c) => c.hex === hex)
    if (!bead) continue
    let nearest = keptBeads[0]
    let nearestDist = Infinity
    for (const keeper of keptBeads) {
      const d = colorDistance(bead.rgb, keeper.rgb)
      if (d < nearestDist) {
        nearestDist = d
        nearest = keeper
      }
    }
    redirect.set(hex, nearest)
  }

  const newFreq = new Map()
  for (const row of grid) {
    for (let idx = 0; idx < row.length; idx++) {
      const cell = row[idx]
      if (cell) {
        const replacement = redirect.get(cell.hex) || cell
        row[idx] = replacement
        newFreq.set(replacement.hex, (newFreq.get(replacement.hex) || 0) + 1)
      }
    }
  }
  return { grid, counts: newFreq }
}

// 采样一个网格单元的代表色
// mode='average'：单元内所有不透明像素的均值（适合照片/真实感）
// mode='dominant'：单元内出现频次最高的色（适合卡通/线条稿，避免黑边）
function sampleCellColor(pixels, width, x0, y0, w, h, mode) {
  let rTotal = 0, gTotal = 0, bTotal = 0, sampled = 0
  let dominantRgb = null
  let dominantCount = 0
  const bucket = new Map()

  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const offset = (y * width + x) * 4
      // alpha < 128 视为透明，跳过
      if (pixels[offset + 3] < 128) continue
      const r = pixels[offset]
      const g = pixels[offset + 1]
      const b = pixels[offset + 2]
      sampled++
      if (mode === 'average') {
        rTotal += r
        gTotal += g
        bTotal += b
      } else {
        const k = (r << 16) | (g << 8) | b
        const cur = (bucket.get(k) || 0) + 1
        bucket.set(k, cur)
        if (cur > dominantCount) {
          dominantCount = cur
          dominantRgb = { r, g, b }
        }
      }
    }
  }

  if (sampled === 0) return null
  if (mode === 'average') {
    return {
      r: Math.round(rTotal / sampled),
      g: Math.round(gTotal / sampled),
      b: Math.round(bTotal / sampled),
    }
  }
  return dominantRgb
}

// 主入口：将画布图像量化为拼豆网格
export function pixelateImage(ctx, imgWidth, imgHeight, cols, rows, mode, maxColors, mergeThreshold = 0) {
  const { data } = ctx.getImageData(0, 0, imgWidth, imgHeight)
  const cellW = imgWidth / cols
  const cellH = imgHeight / rows

  const grid = []
  for (let row = 0; row < rows; row++) {
    const line = []
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(col * cellW)
      const y0 = Math.floor(row * cellH)
      const x1 = Math.min(imgWidth, Math.ceil((col + 1) * cellW))
      const y1 = Math.min(imgHeight, Math.ceil((row + 1) * cellH))
      const cw = Math.max(1, x1 - x0)
      const ch = Math.max(1, y1 - y0)

      const representative = sampleCellColor(data, imgWidth, x0, y0, cw, ch, mode)
      line.push(representative ? findClosestColor(representative) : null)
    }
    grid.push(line)
  }

  return limitColors(grid, maxColors, mergeThreshold)
}

// 导出当前色板供外部使用
export function getPalette() {
  return PALETTE
}
