import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { pixelateImage, getPalette } from './beadAlgorithm'
import { LANGUAGES, getTranslation, detectLanguage, getHtmlLang } from '../i18n/translations'

const BEAD_SIZE = 14
const MAX_RENDER_SCALE = 3 // canvas 最大渲染倍率（防止内存爆炸）
const BASE_SCALE = 2 // 基础渲染分辨率倍率，缩放时不重绘，仅改 CSS 尺寸
const MAX_CANVAS_AREA = 8000000 // 移动端安全上限：800万像素（iOS Safari 限制约 16MP，留余量）

// 根据长边格数 + 图片比例计算 cols × rows
const calcGrid = (img, longSide) => {
  const ratio = img.width / img.height
  let cols, rows
  if (ratio >= 1) {
    cols = longSide
    rows = Math.max(8, Math.round(longSide / ratio))
  } else {
    rows = longSide
    cols = Math.max(8, Math.round(longSide * ratio))
  }
  return { cols, rows }
}

// 根据图片颜色丰富度推荐颜色精简度
const analyzeColors = (img) => {
  const sample = 64
  const c = document.createElement('canvas')
  c.width = sample; c.height = sample
  const ctx = c.getContext('2d')
  const ratio = img.width / img.height
  let dw, dh, dx, dy
  if (ratio >= 1) { dw = sample; dh = sample / ratio; dx = 0; dy = (sample - dh) / 2 }
  else { dh = sample; dw = sample * ratio; dy = 0; dx = (sample - dw) / 2 }
  ctx.drawImage(img, dx, dy, dw, dh)
  const data = ctx.getImageData(0, 0, sample, sample).data
  const set = new Set()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    set.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`)
  }
  // 返回图片实际颜色数（clamp 到 1~283），与原材料清单颜色种类联动
  return Math.min(283, Math.max(1, set.size))
}

// 生成默认金毛图片
const generateGoldenRetriever = () => {
  const w = 96, h = 80
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  const gold = '#e0a854', darkGold = '#b8863a', lightGold = '#f0c878'
  const brown = '#6d4c41', white = '#fafafa', black = '#1a1a1a', pink = '#f8bbd0'

  ctx.fillStyle = gold
  ctx.beginPath(); ctx.ellipse(w / 2, h / 2 + 8, 28, 22, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = white
  ctx.beginPath(); ctx.ellipse(w / 2, h / 2 + 14, 16, 12, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = gold
  ctx.beginPath(); ctx.ellipse(w / 2, 26, 20, 18, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = darkGold
  ctx.beginPath(); ctx.ellipse(w / 2 - 18, 28, 7, 14, 0.3, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(w / 2 + 18, 28, 7, 14, -0.3, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = lightGold
  ctx.beginPath(); ctx.ellipse(w / 2, 30, 10, 8, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = black
  ctx.beginPath(); ctx.arc(w / 2 - 7, 24, 2.5, 0, Math.PI * 2); ctx.arc(w / 2 + 7, 24, 2.5, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = white
  ctx.beginPath(); ctx.arc(w / 2 - 6.5, 23.5, 0.8, 0, Math.PI * 2); ctx.arc(w / 2 + 7.5, 23.5, 0.8, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = black
  ctx.beginPath(); ctx.ellipse(w / 2, 31, 2.5, 2, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = brown; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(w / 2, 33); ctx.lineTo(w / 2, 35)
  ctx.moveTo(w / 2, 35); ctx.quadraticCurveTo(w / 2 - 3, 37, w / 2 - 4, 36)
  ctx.moveTo(w / 2, 35); ctx.quadraticCurveTo(w / 2 + 3, 37, w / 2 + 4, 36)
  ctx.stroke()
  ctx.fillStyle = pink
  ctx.beginPath(); ctx.ellipse(w / 2, 37, 2, 1.5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = gold
  ctx.fillRect(w / 2 - 14, h / 2 + 18, 6, 14)
  ctx.fillRect(w / 2 + 8, h / 2 + 18, 6, 14)
  ctx.fillStyle = lightGold
  ctx.fillRect(w / 2 - 14, h / 2 + 28, 6, 4)
  ctx.fillRect(w / 2 + 8, h / 2 + 28, 6, 4)
  ctx.fillStyle = gold
  ctx.beginPath(); ctx.ellipse(w / 2 + 26, h / 2 - 2, 8, 5, 0.5, 0, Math.PI * 2); ctx.fill()

  return canvas
}

const getDifficultyLabel = (longSide, t) => {
  if (longSide <= 100) return { label: t.difficultyEasy, color: 'text-green-600', bg: 'bg-green-50' }
  if (longSide <= 200) return { label: t.difficultyMedium, color: 'text-amber-600', bg: 'bg-amber-50' }
  return { label: t.difficultyHard, color: 'text-red-600', bg: 'bg-red-50' }
}

/** 拼豆图纸生成器 */
export default function PixelBeadsPage() {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('pixel-beads-lang') || detectLanguage() } catch { return detectLanguage() }
  })
  const t = useMemo(() => getTranslation(lang), [lang])
  const [longSide, setLongSide] = useState(200)
  const [grid, setGrid] = useState({ cols: 48, rows: 40 })
  const [colorCount, setColorCount] = useState(283)
  const [mergeThreshold, setMergeThreshold] = useState(10) // 颜色合并阈值 0~100，默认10
  const [mode, setMode] = useState('average')
  const [isDragOver, setIsDragOver] = useState(false)
  const [beadCounts, setBeadCounts] = useState([])
  const [originalSrc, setOriginalSrc] = useState('')
  const [isDefault, setIsDefault] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [offsetX, setOffsetX] = useState(0)
  const [offsetY, setOffsetY] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  // 支付弹窗状态
  const [payOpen, setPayOpen] = useState(false)
  const [payStatus, setPayStatus] = useState('idle') // idle | processing | success

  // 数值输入框的显示值（允许空字符串，blur 时再校验）
  const [longSideInput, setLongSideInput] = useState('200')
  const [colorCountInput, setColorCountInput] = useState('283')
  const [mergeThresholdInput, setMergeThresholdInput] = useState('10')

  const previewCanvasRef = useRef(null)
  const sourceCanvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const sourceImgRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const dragRef = useRef({ startX: 0, startY: 0, ox: 0, oy: 0 })
  const touchRef = useRef({ mode: null, dist: 0, startZoom: 1, startX: 0, startY: 0, ox: 0, oy: 0, cx: 0, cy: 0 })
  // 左右键同时按检测
  const rightPressedRef = useRef(false)
  const leftClickTimerRef = useRef(null)
  const longPressTimerRef = useRef(null)
  const fitTimerRef = useRef(null)
  // 缩放/偏移的实时镜像，供滚轮缩放读取最新值（避免在 setState updater 内嵌套调用 setState）
  const zoomRef = useRef(zoom)
  const offsetXRef = useRef(offsetX)
  const offsetYRef = useRef(offsetY)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { offsetXRef.current = offsetX }, [offsetX])
  useEffect(() => { offsetYRef.current = offsetY }, [offsetY])

  // 计算 beadGrid（不依赖 zoom，参数变化时自动重算）
  const beadResult = useMemo(() => {
    const sourceCanvas = sourceCanvasRef.current
    if (!sourceCanvas || !sourceImgRef.current) return { grid: [], counts: new Map() }
    const sctx = sourceCanvas.getContext('2d')
    // 滑块 0~100 映射到 OKLab 距离阈值 0~0.5
    const threshold = (mergeThreshold / 100) * 0.5
    // 合并阈值与颜色数量限制同时生效：先按阈值合并相似色，再限制到 colorCount 种
    const effectiveMaxColors = colorCount
    return pixelateImage(sctx, sourceCanvas.width, sourceCanvas.height, grid.cols, grid.rows, mode, effectiveMaxColors, threshold)
  }, [grid, mode, colorCount, mergeThreshold])

  // 同步数值显示值（滑块/外部变化时更新输入框）
  useEffect(() => { setLongSideInput(String(longSide)) }, [longSide])
  useEffect(() => { setColorCountInput(String(colorCount)) }, [colorCount])
  useEffect(() => { setMergeThresholdInput(String(mergeThreshold)) }, [mergeThreshold])

  // 语言持久化到 localStorage
  useEffect(() => {
    try { localStorage.setItem('pixel-beads-lang', lang) } catch {}
  }, [lang])
  const handleLangChange = (code) => setLang(code)

  // 页面标题 / 语言标签 / meta 随语言切换
  useEffect(() => {
    document.title = t.pageTitle
    document.documentElement.lang = getHtmlLang(lang)
    const setMeta = (selector, attr, value) => {
      const el = document.head.querySelector(selector)
      if (el) el.setAttribute(attr, value)
    }
    setMeta('meta[name="description"]', 'content', t.metaDescription)
    setMeta('meta[property="og:title"]', 'content', t.pageTitle)
    setMeta('meta[property="og:description"]', 'content', t.metaDescription)
    setMeta('meta[property="og:locale"]', 'content', getHtmlLang(lang).replace('-', '_'))
  }, [lang, t])

  // 渲染画布（仅依赖 beadResult + grid，不依赖 zoom；zoom 变化只改 CSS 尺寸）
  const renderCanvas = useCallback(() => {
    const canvas = previewCanvasRef.current
    if (!canvas || !beadResult.grid.length) return
    const { cols, rows } = grid
    const beadGrid = beadResult.grid

    // 固定 BASE_SCALE 分辨率渲染，缩放时不重绘
    // 但若总面积超过移动端安全上限，自动降低倍率，避免 iOS Safari 等浏览器画布变空白
    const baseArea = cols * rows * BEAD_SIZE * BEAD_SIZE
    let scale = BASE_SCALE
    if (baseArea * scale * scale > MAX_CANVAS_AREA) {
      scale = Math.sqrt(MAX_CANVAS_AREA / baseArea)
    }
    canvas.width = Math.round(cols * BEAD_SIZE * scale)
    canvas.height = Math.round(rows * BEAD_SIZE * scale)

    const ctx = canvas.getContext('2d')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.imageSmoothingEnabled = true

    ctx.fillStyle = '#f5f5f5'
    ctx.fillRect(0, 0, cols * BEAD_SIZE, rows * BEAD_SIZE)

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = beadGrid[y][x]
        if (!cell) continue
        const px = x * BEAD_SIZE, py = y * BEAD_SIZE
        const r = BEAD_SIZE / 2 - 1

        ctx.fillStyle = cell.hex
        ctx.beginPath()
        ctx.arc(px + BEAD_SIZE / 2, py + BEAD_SIZE / 2, r, 0, Math.PI * 2)
        ctx.fill()

        const grad = ctx.createRadialGradient(
          px + BEAD_SIZE / 2 - 2, py + BEAD_SIZE / 2 - 2, 1,
          px + BEAD_SIZE / 2, py + BEAD_SIZE / 2, r
        )
        grad.addColorStop(0, 'rgba(255,255,255,0.4)')
        grad.addColorStop(0.5, 'rgba(255,255,255,0)')
        grad.addColorStop(1, 'rgba(0,0,0,0.12)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(px + BEAD_SIZE / 2, py + BEAD_SIZE / 2, r, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = 'rgba(0,0,0,0.18)'
        ctx.beginPath()
        ctx.arc(px + BEAD_SIZE / 2, py + BEAD_SIZE / 2, 1.8, 0, Math.PI * 2)
        ctx.fill()

        const luminance = (cell.rgb.r * 299 + cell.rgb.g * 587 + cell.rgb.b * 114) / 1000
        ctx.fillStyle = luminance > 140 ? '#000000' : '#ffffff'
        ctx.font = `${Math.max(5, Math.round(BEAD_SIZE * 0.38))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(cell.name, px + BEAD_SIZE / 2, py + BEAD_SIZE / 2)
      }
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.07)'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= cols; i++) {
      ctx.beginPath(); ctx.moveTo(i * BEAD_SIZE, 0); ctx.lineTo(i * BEAD_SIZE, rows * BEAD_SIZE); ctx.stroke()
    }
    for (let i = 0; i <= rows; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * BEAD_SIZE); ctx.lineTo(cols * BEAD_SIZE, i * BEAD_SIZE); ctx.stroke()
    }

    // 珠子计数
    const list = []
    beadResult.counts.forEach((count, hex) => {
      const p = getPalette().find((c) => c.hex === hex)
      if (p) list.push({ color: p, count })
    })
    list.sort((a, b) => b.count - a.count)
    setBeadCounts(list)
  }, [beadResult, grid])

  // 缩放时仅更新 canvas CSS 显示尺寸（不重绘，极速）
  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return
    const { cols, rows } = grid
    canvas.style.width = `${cols * BEAD_SIZE * zoom}px`
    canvas.style.height = `${rows * BEAD_SIZE * zoom}px`
  }, [zoom, grid])

  // 自动适配容器：居中显示全部，尽量填满去白边
  const fitToScreen = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const { cols, rows } = grid
    const availW = container.clientWidth
    const availH = container.clientHeight
    const contentW = cols * BEAD_SIZE
    const contentH = rows * BEAD_SIZE
    if (contentW <= 0 || contentH <= 0) return
    // 取较小比例保证完整显示，图片居中，白边最小
    const z = Math.min(availW / contentW, availH / contentH)
    setZoom(+z.toFixed(4))
    setOffsetX(0)
    setOffsetY(0)
  }, [grid])

  // 用 ref 保存最新 renderCanvas，避免 effect 依赖它导致循环
  const renderCanvasRef = useRef(null)
  useEffect(() => { renderCanvasRef.current = renderCanvas }, [renderCanvas])

  // 图纸更新（beadResult 变化）→ 渲染 + 自动适配
  useEffect(() => {
    if (beadResult.grid.length > 0) {
      renderCanvasRef.current?.()
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
      fitTimerRef.current = setTimeout(() => fitToScreen(), 50)
    }
    return () => { if (fitTimerRef.current) clearTimeout(fitTimerRef.current) }
  }, [beadResult, fitToScreen])

  // 加载图片
  const loadImage = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      sourceImgRef.current = img
      setOriginalSrc(url)
      setIsDefault(false)
      const defaultLongSide = 200
      setLongSide(defaultLongSide)
      setGrid(calcGrid(img, defaultLongSide))
      setColorCount(analyzeColors(img))
      const sc = sourceCanvasRef.current
      if (sc) {
        sc.width = img.width
        sc.height = img.height
        sc.getContext('2d').drawImage(img, 0, 0)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); alert('图片加载失败') }
    img.src = url
  }, [])

  // 默认加载狗狗示例图
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      sourceImgRef.current = img
      setOriginalSrc('/default-dog.png')
      const defaultLongSide = 200
      setLongSide(defaultLongSide)
      setGrid(calcGrid(img, defaultLongSide))
      setColorCount(analyzeColors(img))
      const sc = sourceCanvasRef.current
      if (sc) {
        sc.width = img.width
        sc.height = img.height
        sc.getContext('2d').drawImage(img, 0, 0)
      }
    }
    img.onerror = () => {
      // 图片加载失败时回退到生成的金毛图
      const def = generateGoldenRetriever()
      const fallbackImg = new Image()
      fallbackImg.onload = () => {
        sourceImgRef.current = fallbackImg
        setOriginalSrc(def.toDataURL())
        const defaultLongSide = 200
        setLongSide(defaultLongSide)
        setGrid(calcGrid(fallbackImg, defaultLongSide))
        setColorCount(analyzeColors(fallbackImg))
        const sc = sourceCanvasRef.current
        if (sc) {
          sc.width = fallbackImg.width
          sc.height = fallbackImg.height
          sc.getContext('2d').drawImage(fallbackImg, 0, 0)
        }
      }
      fallbackImg.src = def.toDataURL()
    }
    img.src = '/default-dog.png'
  }, [])

  // 长边滑块变化
  const handleLongSideChange = (val) => {
    setLongSide(val)
    if (sourceImgRef.current) {
      setGrid(calcGrid(sourceImgRef.current, val))
    }
  }

  // 颜色合并阈值变化：归零时临时解除颜色数量限制，让颜色恢复
  const handleMergeThresholdChange = (val) => {
    setMergeThreshold(val)
    if (val === 0) setColorCount(283)
  }

  // 鼠标滚轮缩放（以鼠标位置为中心）
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const container = scrollContainerRef.current
    const rect = container.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const z = zoomRef.current
    const newZoom = Math.min(5, Math.max(0.1, +(z * factor).toFixed(3)))
    const ratio = newZoom / z
    // 以鼠标位置为中心缩放
    setOffsetX(mx - (mx - offsetXRef.current) * ratio)
    setOffsetY(my - (my - offsetYRef.current) * ratio)
    setZoom(newZoom)
  }, [])

  // 鼠标拖拽
  const handleMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    setIsDragging(true)
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offsetX, oy: offsetY }
  }
  const handleMouseMove = (e) => {
    if (!isDragging) return
    setOffsetX(dragRef.current.ox + (e.clientX - dragRef.current.startX))
    setOffsetY(dragRef.current.oy + (e.clientY - dragRef.current.startY))
  }
  const handleMouseUp = () => setIsDragging(false)
  // 补充：鼠标移出窗口时仍能结束拖拽
  useEffect(() => {
    if (!isDragging) return
    const onUp = () => setIsDragging(false)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [isDragging])

  // 触屏：单指拖拽 + 双指缩放
  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      touchRef.current = {
        mode: 'drag',
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        ox: offsetX, oy: offsetY,
      }
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const container = scrollContainerRef.current
      const rect = container.getBoundingClientRect()
      touchRef.current = {
        mode: 'pinch',
        dist: Math.hypot(dx, dy),
        startZoom: zoom,
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
        ox: offsetX, oy: offsetY,
      }
    }
  }
  const handleTouchMove = (e) => {
    e.preventDefault()
    const t = touchRef.current
    if (t.mode === 'drag' && e.touches.length === 1) {
      setOffsetX(t.ox + (e.touches[0].clientX - t.startX))
      setOffsetY(t.oy + (e.touches[0].clientY - t.startY))
    } else if (t.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.hypot(dx, dy)
      const newZoom = Math.min(5, Math.max(0.1, +(t.startZoom * (dist / t.dist)).toFixed(3)))
      const ratio = newZoom / t.startZoom
      setZoom(newZoom)
      setOffsetX(t.cx - (t.cx - t.ox) * ratio)
      setOffsetY(t.cy - (t.cy - t.oy) * ratio)
    }
  }
  const handleTouchEnd = () => { touchRef.current.mode = null }

  // 键盘缩放
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(5, +(z + 0.1).toFixed(2)))
      } else if (e.key === '-') {
        setZoom((z) => Math.max(0.1, +(z - 0.1).toFixed(2)))
      } else if (e.key === '0') {
        fitToScreen()
      } else if (e.key === 'f' || e.key === 'F') {
        fitToScreen()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fitToScreen])

  const handleFileInput = (e) => {
    const file = e.target.files?.[0]
    if (file) loadImage(file)
    e.target.value = ''
  }
  const handleDragOver = (e) => { e.preventDefault(); setIsDragOver(true) }
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragOver(false) }
  const handleDrop = (e) => {
    e.preventDefault(); setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) loadImage(file)
  }

  // 导出高清合并 PNG
  const handleExport = () => {
    const beadCanvas = previewCanvasRef.current
    if (!beadCanvas) return
    // 导出时用 1:1 原始尺寸渲染（不缩放）
    const { cols, rows } = grid
    const padding = 40, titleH = 60, listW = 300
    const totalW = beadCanvas.width + listW + padding * 3
    const totalH = Math.max(beadCanvas.height + titleH + padding * 2, 420)

    const ec = document.createElement('canvas')
    ec.width = totalW; ec.height = totalH
    const ectx = ec.getContext('2d')
    ectx.fillStyle = '#ffffff'; ectx.fillRect(0, 0, totalW, totalH)

    ectx.fillStyle = '#1a1a1a'; ectx.font = 'bold 28px sans-serif'; ectx.textAlign = 'left'
    ectx.fillText(t.exportSheetTitle, padding, 42)
    ectx.font = '14px sans-serif'; ectx.fillStyle = '#666'
    ectx.fillText(t.exportSheetMeta(cols, rows, beadCounts.length), padding, 64)
    ectx.drawImage(beadCanvas, padding, titleH + padding)

    let ly = titleH + padding + 10
    ectx.fillStyle = '#1a1a1a'; ectx.font = 'bold 18px sans-serif'
    ectx.fillText(t.exportCountTitle, beadCanvas.width + padding * 2, ly)
    ly += 32
    beadCounts.forEach(({ color, count }) => {
      const cx = beadCanvas.width + padding * 2
      ectx.fillStyle = color.hex
      ectx.beginPath(); ectx.arc(cx + 12, ly - 6, 10, 0, Math.PI * 2); ectx.fill()
      ectx.strokeStyle = '#ccc'; ectx.lineWidth = 1; ectx.stroke()
      ectx.fillStyle = '#333'; ectx.font = '14px sans-serif'
      ectx.fillText(t.exportCountItem(color.name, count), cx + 30, ly - 1)
      ly += 28
      if (ly > totalH - 50) return
    })
    const total = beadCounts.reduce((s, b) => s + b.count, 0)
    ectx.fillStyle = '#e53935'; ectx.font = 'bold 15px sans-serif'
    ectx.fillText(t.totalBeads(total), beadCanvas.width + padding * 2, ly + 12)

    ec.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pixel-beads-${cols}x${rows}-${Date.now()}.png`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png', 1.0)
  }

  // ===== 支付 & 下载逻辑 =====
  // 左键单击 → 打开支付弹窗；左右键同时按 → 直接免费下载

  const doFreeDownload = useCallback(() => {
    handleExport()
  }, [handleExport])

  const openPaymentModal = () => {
    setPayStatus('idle')
    setPayOpen(true)
  }

  const closePaymentModal = () => {
    setPayOpen(false)
    setPayStatus('idle')
  }

  // 模拟支付流程 —— 接入真实支付时替换此函数体
  // 可对接：Stripe / 微信支付 / 支付宝 / PayPal 等
  const processPayment = () => {
    setPayStatus('processing')
    // === 真实支付接入示例 ===
    // fetch('/api/payment/create', { method: 'POST', body: JSON.stringify({ amount: 9.9 }) })
    //   .then(r => r.json())
    //   .then(({ checkoutUrl }) => { window.location.href = checkoutUrl })
    // 支付网关回调到 /api/payment/verify 后再触发下载
    // ========================
    setTimeout(() => {
      setPayStatus('success')
      setTimeout(() => {
        handleExport()
        closePaymentModal()
      }, 800)
    }, 1500)
  }

  // 导出按钮指针按下：统一处理鼠标（左键/右键）和触摸（短按支付/长按免费）
  const handleExportPointerDown = (e) => {
    if (e.pointerType === 'touch') {
      // 移动端：长按 500ms → 免费下载；短按 → 打开支付弹窗
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        doFreeDownload()
      }, 500)
      return
    }
    // 桌面端鼠标逻辑
    if (e.button === 0) {
      // 左键按下：延迟判定，等待右键是否同时按下
      if (leftClickTimerRef.current) clearTimeout(leftClickTimerRef.current)
      leftClickTimerRef.current = setTimeout(() => {
        if (!rightPressedRef.current) openPaymentModal()
        rightPressedRef.current = false
      }, 250)
    } else if (e.button === 2) {
      // 右键按下：若左键已按下则触发免费下载
      rightPressedRef.current = true
      if (leftClickTimerRef.current) {
        clearTimeout(leftClickTimerRef.current)
        leftClickTimerRef.current = null
        rightPressedRef.current = false
        doFreeDownload()
      }
    }
  }

  const handleExportPointerUp = (e) => {
    if (e.pointerType === 'touch') {
      // 移动端：若长按未触发（短按），则打开支付弹窗
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
        openPaymentModal()
      }
      return
    }
    if (e.button === 2) {
      setTimeout(() => { rightPressedRef.current = false }, 150)
    }
  }

  const handleExportContextMenu = (e) => {
    e.preventDefault()
  }

  // 组件卸载时清理定时器
  useEffect(() => () => {
    if (leftClickTimerRef.current) clearTimeout(leftClickTimerRef.current)
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
  }, [])

  const totalBeads = useMemo(() => beadCounts.reduce((s, b) => s + b.count, 0), [beadCounts])
  const diffInfo = getDifficultyLabel(longSide, t)
  const contentW = grid.cols * BEAD_SIZE * zoom
  const contentH = grid.rows * BEAD_SIZE * zoom

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 flex flex-col">
      <canvas ref={sourceCanvasRef} className="hidden" />

      <main className="flex-1 px-4 py-6">
        <div className="max-w-[1400px] mx-auto flex gap-4">
          {/* 左侧广告位 */}
          <aside className="hidden lg:flex flex-col gap-4 w-32 flex-shrink-0">
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-3 text-center sticky top-6">
              <span className="inline-block text-[10px] text-gray-400 uppercase tracking-wider mb-1">{t.adLabel}</span>
              <div className="flex items-center justify-center h-64 text-gray-300 text-xs bg-gray-50 rounded-lg">
                {t.adPlaceholder}
              </div>
            </div>
          </aside>

          {/* 主内容 */}
          <div className="flex-1 min-w-0">
          {/* 顶部标题 + 语言切换 */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex-1" />
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 text-center flex-1">
              ✨ {t.appTitle}
            </h1>
            <div className="flex-1 flex justify-end">
              <select
                value={lang}
                onChange={(e) => handleLangChange(e.target.value)}
                className="text-xs bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-gray-700 outline-none focus:ring-2 focus:ring-blue-300 cursor-pointer"
                title={t.language}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.flag} {l.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 步骤引导 */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              {t.steps.map((text, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex items-center gap-2 bg-blue-50 rounded-full px-3 py-1.5">
                    <span className="w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">
                      {i + 1}
                    </span>
                    <span className="text-sm text-blue-700 font-medium whitespace-nowrap">
                      {['📷', '📐', '🎨', '📥'][i]} {text}
                    </span>
                  </div>
                  {i < 3 && (
                    <svg className="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 两栏布局 */}
          <div className="grid md:grid-cols-[340px_1fr] gap-5">
            {/* 左区：控制台 */}
            <div className="space-y-4">
              {/* 上传区 */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`rounded-2xl border-2 border-dashed p-4 text-center cursor-pointer transition-all ${
                    isDragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/50'
                  }`}
                >
                  {originalSrc ? (
                    <div className="flex flex-col items-center">
                      <img
                        src={originalSrc}
                        alt={t.uploaded}
                        className="max-w-full max-h-44 object-contain rounded-lg border border-gray-200 mb-2"
                      />
                      <p className="text-xs font-medium text-gray-700">
                        {isDefault ? t.defaultImg : t.uploaded}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{t.changeImg}</p>
                    </div>
                  ) : (
                    <>
                      <div className="text-5xl mb-3">🖼️</div>
                      <p className="text-base font-semibold text-gray-700">{t.uploadTitle}</p>
                      <p className="text-xs text-gray-400 mt-1">{t.uploadHint}</p>
                    </>
                  )}
                  <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/jpg,image/gif" onChange={handleFileInput} className="hidden" />
                </div>
                {isDefault && (
                  <p className="mt-2 text-xs text-amber-600 text-center">{t.defaultTip}</p>
                )}
              </div>

              {/* 格子数滑块 */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700">{t.gridTitle}</h2>
                  <div className="flex items-center gap-1">
                    <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${diffInfo.bg} ${diffInfo.color}`}>
                      {diffInfo.label}
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={longSideInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '')
                        setLongSideInput(v)
                      }}
                      onBlur={(e) => {
                        const v = e.target.value.replace(/\D/g, '')
                        if (v) handleLongSideChange(Math.min(300, Math.max(50, parseInt(v))))
                        else setLongSideInput(String(longSide))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = e.target.value.replace(/\D/g, '')
                          if (v) handleLongSideChange(Math.min(300, Math.max(50, parseInt(v))))
                          else setLongSideInput(String(longSide))
                          e.currentTarget.blur()
                        }
                      }}
                      className={`w-14 text-center text-xs font-bold rounded-full px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-amber-300 ${diffInfo.bg} ${diffInfo.color}`}
                    />
                    <span className={`text-xs font-bold ${diffInfo.color}`}>{t.gridUnit}</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={50}
                  max={300}
                  value={longSide}
                  onChange={(e) => handleLongSideChange(Number(e.target.value))}
                  className="w-full h-3 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: 'linear-gradient(to right, #22c55e 0%, #22c55e 33%, #eab308 33%, #eab308 66%, #ef4444 66%, #ef4444 100%)',
                  }}
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span className="text-green-600">{t.gridRange[0]}</span>
                  <span className="text-amber-600">{t.gridRange[1]}</span>
                  <span className="text-red-600">{t.gridRange[2]}</span>
                </div>
                <p className="mt-2 text-xs text-gray-400">{t.currentCanvas(grid.cols, grid.rows)}</p>
              </div>

              {/* 颜色精简度（已隐藏） */}
              <div className="hidden bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700">{t.colorTitle}</h2>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={colorCountInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '')
                        setColorCountInput(v)
                      }}
                      onBlur={(e) => {
                        const v = e.target.value.replace(/\D/g, '')
                        if (v) setColorCount(Math.min(283, Math.max(1, parseInt(v))))
                        else setColorCountInput(String(colorCount))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = e.target.value.replace(/\D/g, '')
                          if (v) setColorCount(Math.min(283, Math.max(1, parseInt(v))))
                          else setColorCountInput(String(colorCount))
                          e.currentTarget.blur()
                        }
                      }}
                      className="w-12 text-center text-xs font-bold text-blue-500 bg-blue-50 rounded-full px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-300"
                    />
                    <span className="text-xs font-bold text-blue-500">{t.colorUnit}</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={283}
                  value={colorCount}
                  onChange={(e) => setColorCount(Number(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>{t.colorRange[0]}</span>
                  <span>{t.colorRange[1]}</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{t.colorAuto}</p>
              </div>

              {/* 颜色合并阈值 */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700">{t.mergeTitle}</h2>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={mergeThresholdInput}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '')
                      setMergeThresholdInput(v)
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.replace(/\D/g, '')
                      if (v) handleMergeThresholdChange(Math.min(100, Math.max(0, parseInt(v))))
                      else setMergeThresholdInput(String(mergeThreshold))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = e.target.value.replace(/\D/g, '')
                        if (v) handleMergeThresholdChange(Math.min(100, Math.max(0, parseInt(v))))
                        else setMergeThresholdInput(String(mergeThreshold))
                        e.currentTarget.blur()
                      }
                    }}
                    className="w-12 text-center text-xs font-bold text-teal-600 bg-teal-50 rounded-full px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-teal-300"
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={mergeThreshold}
                  onChange={(e) => handleMergeThresholdChange(Number(e.target.value))}
                  className="w-full h-3 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: 'linear-gradient(to right, #99f6e4 0%, #14b8a6 50%, #0f766e 100%)',
                  }}
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>{t.mergeRange[0]}</span>
                  <span>{t.mergeRange[1]}</span>
                  <span>{t.mergeRange[2]}</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{t.mergeHint}</p>
              </div>

              {/* 像素化模式（已隐藏，默认使用真实/平均色） */}
              <div className="hidden">
                <h2 className="text-sm font-semibold text-gray-700 mb-3">像素化模式</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode('average')}
                    className={`flex-1 rounded-full py-2 text-xs font-medium transition-all ${
                      mode === 'average' ? 'bg-purple-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    真实（平均色）
                  </button>
                  <button
                    onClick={() => setMode('dominant')}
                    className={`flex-1 rounded-full py-2 text-xs font-medium transition-all ${
                      mode === 'dominant' ? 'bg-purple-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    卡通（主色）
                  </button>
                </div>
              </div>

              {/* 导出按钮 */}
              <button
                onPointerDown={handleExportPointerDown}
                onPointerUp={handleExportPointerUp}
                onPointerCancel={() => {
                  if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
                }}
                onContextMenu={handleExportContextMenu}
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-bold bg-green-500 text-white hover:bg-green-600 active:scale-[0.98] transition-all shadow-lg shadow-green-500/20 select-none touch-none"
              >
                {t.exportBtn}
              </button>
            </div>

            {/* 右区：拼豆结果 */}
            <div className="space-y-4 min-w-0">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700">{t.resultTitle}</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{grid.cols}×{grid.rows}</span>
                    <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-1">
                      <button
                        onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.1).toFixed(2)))}
                        className="w-6 h-6 rounded text-gray-600 hover:bg-gray-200 text-sm"
                        title={t.zoomOut}
                      >−</button>
                      <span className="text-xs text-gray-600 w-10 text-center">{Math.round(zoom * 100)}%</span>
                      <button
                        onClick={() => setZoom((z) => Math.min(5, +(z + 0.1).toFixed(2)))}
                        className="w-6 h-6 rounded text-gray-600 hover:bg-gray-200 text-sm"
                        title={t.zoomIn}
                      >+</button>
                      <button
                        onClick={fitToScreen}
                        className="w-6 h-6 rounded text-gray-600 hover:bg-gray-200 text-xs"
                        title={t.fit}
                      >{t.fit}</button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  💡 {t.zoomHint}
                </p>
                <div
                  ref={scrollContainerRef}
                  onWheel={handleWheel}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  className="bg-gray-50 rounded-xl p-3 overflow-hidden min-h-[400px] max-h-[70vh] relative select-none"
                  style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
                >
                  <div
                    style={{
                      width: contentW,
                      height: contentH,
                      position: 'absolute',
                      left: `calc(50% + ${offsetX}px)`,
                      top: `calc(50% + ${offsetY}px)`,
                      transform: 'translate(-50%, -50%)',
                      transition: isDragging ? 'none' : 'transform 0.05s linear',
                    }}
                  >
                    <canvas
                      ref={previewCanvasRef}
                      className="rounded-lg"
                      style={{
                        display: 'block',
                        imageRendering: 'auto',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 珠子清单 + Amazon */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-gray-700">{t.materialTitle}</h2>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
                        {t.colorTypes(beadCounts.length)}
                      </span>
                      <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">
                        {t.totalBeads(totalBeads)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                    {beadCounts.length === 0 ? (
                      <p className="text-sm text-gray-400">{t.noMaterial}</p>
                    ) : (
                      beadCounts.map(({ color, count }, i) => (
                        <div key={i} className="flex items-center gap-1 bg-gray-50 rounded-full px-2 py-0.5">
                          <span className="w-3 h-3 rounded-full border border-gray-200" style={{ backgroundColor: color.hex }} />
                          <span className="text-xs text-gray-600">{color.name}</span>
                          <span className="text-xs font-semibold text-gray-800">×{count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <a
                  href="#"
                  onClick={(e) => e.preventDefault()}
                  className="block bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-4 hover:shadow-md transition-all flex flex-col justify-center"
                >
                  <div className="flex items-start gap-2">
                    <div className="text-2xl">🛒</div>
                    <div>
                      <p className="text-sm font-semibold text-amber-800">{t.buyTitle}</p>
                      <p className="text-xs text-amber-600 mt-1">{t.buyDesc}</p>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>

          {/* 底部广告位 */}
          <div className="mt-5">
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-4 text-center">
              <span className="inline-block text-[10px] text-gray-400 uppercase tracking-wider mb-1">{t.adLabel}</span>
              <div className="flex items-center justify-center h-20 text-gray-300 text-sm bg-gray-50 rounded-lg">
                {t.adPlaceholder}
              </div>
            </div>
          </div>
          </div>{/* 主内容结束 */}

          {/* 右侧广告位 */}
          <aside className="hidden lg:flex flex-col gap-4 w-32 flex-shrink-0">
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-3 text-center sticky top-6">
              <span className="inline-block text-[10px] text-gray-400 uppercase tracking-wider mb-1">{t.adLabel}</span>
              <div className="flex items-center justify-center h-64 text-gray-300 text-xs bg-gray-50 rounded-lg">
                {t.adPlaceholder}
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* 页脚 */}
      <footer className="bg-white border-t border-gray-200 px-4 py-6">
        <div className="max-w-7xl mx-auto text-center text-xs text-gray-500 space-y-2">
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <a href="/privacy.html" className="hover:text-blue-600 transition-colors">{t.footerPrivacy}</a>
            <span className="text-gray-300">|</span>
            <a href="/terms.html" className="hover:text-blue-600 transition-colors">{t.footerTerms}</a>
            <span className="text-gray-300">|</span>
            <a href="/disclaimer.html" className="hover:text-blue-600 transition-colors">{t.footerDisclaimer}</a>
          </div>
          <p>© {new Date().getFullYear()} {t.appTitle}. {t.footerRights}.</p>
        </div>
      </footer>

      {/* 支付弹窗 */}
      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) closePaymentModal() }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <div className="text-center">
              <div className="text-4xl mb-3">🔒</div>
              <h3 className="text-lg font-bold text-gray-800 mb-1">{t.payTitle}</h3>
              <p className="text-sm text-gray-500 mb-4">{t.payDesc}</p>

              <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 mb-4">
                <div className="text-3xl font-bold text-green-600">{t.payAmount}</div>
              </div>

              <button
                onClick={payStatus === 'idle' ? processPayment : undefined}
                disabled={payStatus !== 'idle'}
                className={`w-full rounded-xl py-3 text-sm font-bold transition-colors ${
                  payStatus === 'idle'
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : payStatus === 'processing'
                    ? 'bg-gray-100 text-gray-500 cursor-wait'
                    : 'bg-green-100 text-green-700'
                }`}
              >
                {payStatus === 'idle' && t.payBtn}
                {payStatus === 'processing' && (
                  <span className="inline-flex items-center justify-center gap-2">
                    <span className="animate-spin">⏳</span> {t.payProcessing}
                  </span>
                )}
                {payStatus === 'success' && <>✅ {t.paySuccess}</>}
              </button>

              <button
                onClick={closePaymentModal}
                className="mt-3 text-xs text-gray-400 hover:text-gray-600"
              >
                {t.payCancel}
              </button>
              <p className="mt-3 text-[11px] text-gray-400">{t.payNote}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
