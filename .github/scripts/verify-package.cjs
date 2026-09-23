#!/usr/bin/env node
/**
 * 安装包静态校验（本地与 GitHub Actions 共用）。
 *
 *   node .github/scripts/verify-package.cjs                  # 全套校验（需要 dist/ 产物）
 *   node .github/scripts/verify-package.cjs --skip=compare   # 跳过 asar↔out 逐文件比对
 *   node .github/scripts/verify-package.cjs --preinstall     # npm ci 之后立刻跑：只断言 pi 依赖版本
 *   node .github/scripts/verify-package.cjs --v=1.3.0        # 显式指定被校验的产物版本
 *
 * 为什么要有这些断言：
 *  - pi 运行时（@earendil-works/*）是**指定版本**依赖，装错版本 = 运行时行为漂移。
 *    期望值一律从 package-lock.json 推导，不写死字面量；package.json 的 dependencies、
 *    overrides 与之交叉核对，任一不一致即失败。
 *  - asar↔out 逐文件 sha256 比对是「包里的代码就是本次构建的代码」的硬证据，
 *    顺带排掉「源码改了但包没刷新」。
 *  - NSIS 安装包内字符串是 UTF-16LE：**不要**用 latin1 找版本串（恒假阴性），
 *    版本号断言走 VersionInfo。
 *  - @electron/asar 读包内文件必须传 path.join(...) 生成的相对路径
 *    （该库用 path.sep 切分目录；正斜杠或 listPackage 返回的前导反斜杠都会 not found）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist')
const UNPACKED = path.join(DIST, 'win-unpacked')
const ASAR = path.join(UNPACKED, 'resources', 'app.asar')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const skip = new Set(
  argv
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
)
const versionArg = (argv.find((a) => a.startsWith('--v=')) || '').slice('--v='.length)
const preinstallOnly = argv.includes('--preinstall')
const VERSION = versionArg || PKG.version

const results = []
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ level: 'PASS', name, detail: detail || '' })
  } catch (e) {
    results.push({ level: 'FAIL', name, detail: e.message })
  }
}
function warn(name, detail) {
  results.push({ level: 'WARN', name, detail })
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/**
 * 从 lock 推导 @earendil-works/* 的期望版本（含嵌套层级），并与 package.json 声明交叉核对。
 * 返回 { versions: Map<包名, 版本>, paths: string[] } —— paths 是 lock 里的包目录相对路径，
 * 直接用它们核对 node_modules（不写死字面量，也不假设被提升到顶层）。
 */
function piExpectations() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const versions = new Map()
  const entries = []
  for (const [key, entry] of Object.entries(lock.packages)) {
    const m = /^((?:.*\/)?node_modules\/@earendil-works\/([^/]+))$/.exec(key)
    if (!m) continue
    const name = m[2]
    entries.push({ rel: m[1], name, version: entry.version })
    const seen = versions.get(name)
    assert(
      !seen || seen === entry.version,
      `@earendil-works/${name} 在 lock 里有多个版本：${seen} / ${entry.version}`
    )
    versions.set(name, entry.version)
  }
  assert(entries.length > 0, 'package-lock.json 里找不到 @earendil-works/* 条目')
  for (const [name, version] of Object.entries({ ...PKG.dependencies, ...PKG.overrides })) {
    const m = /^@earendil-works\/(.+)$/.exec(name)
    if (!m) continue
    const locked = versions.get(m[1])
    assert(locked, `package.json 声明了 ${name}@${version}，lock 里却没有对应条目`)
    assert(
      locked === version,
      `${name} 声明与锁定不一致：package.json=${version} lock=${locked}`
    )
  }
  return { versions, entries }
}

/** asar 内路径：必须用 path.join 生成（见文件头说明）。 */
function asarRead(asar, ...parts) {
  return require('@electron/asar').extractFile(asar, path.join(...parts))
}

function asarJson(asar, ...parts) {
  return JSON.parse(asarRead(asar, ...parts).toString('utf8'))
}

const relParts = (entry) => entry.replace(/^[\\/]+/, '').split(/[\\/]/)

function walk(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, base, acc)
    else acc.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return acc
}

function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------- preinstall
if (preinstallOnly) {
  check('pi 依赖（node_modules）版本 = lock 锁定版本', () => {
    const { versions, entries } = piExpectations()
    const bad = []
    for (const { rel, name, version } of entries) {
      const file = path.join(ROOT, ...rel.split('/'), 'package.json')
      if (!fs.existsSync(file)) {
        bad.push(`${rel} 未安装`)
        continue
      }
      const got = JSON.parse(fs.readFileSync(file, 'utf8')).version
      if (got !== version) bad.push(`${rel}: 实际 ${got} ≠ 期望 ${version}`)
    }
    assert(bad.length === 0, bad.join('; '))
    const list = [...versions].map(([n, v]) => `${n}@${v}`).join(', ')
    return `${entries.length} 个包目录：${list}`
  })
  report()
  process.exit(process.exitCode || 0)
}

// ------------------------------------------------------------------- 产物层
const exeName = `ChatAnyTime Setup ${VERSION}.exe`
const exePath = path.join(DIST, exeName)

check('产物存在（exe / blockmap / latest.yml）', () => {
  assert(fs.existsSync(exePath), `缺少 ${exeName}`)
  for (const p of [`${exePath}.blockmap`, path.join(DIST, 'latest.yml')]) {
    assert(fs.existsSync(p), `缺少 ${path.basename(p)}`)
  }
  return `${exeName}（${fs.statSync(exePath).size} 字节）`
})

check('latest.yml 与产物一致', () => {
  const text = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8')
  const v = /^version:\s*["']?([^"'\s]+)["']?/m.exec(text)
  assert(v, 'latest.yml 里没有 version 字段')
  assert(v[1] === VERSION, `latest.yml version=${v[1]} ≠ 期望 ${VERSION}`)
  const sizes = [...text.matchAll(/^\s+size:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]))
  assert(sizes.length > 0, 'latest.yml 里没有 files[].size')
  assert(
    sizes[0] === fs.statSync(exePath).size,
    `latest.yml 记录 ${sizes[0]} 字节 ≠ 实际 ${fs.statSync(exePath).size}`
  )
  return `version=${v[1]} size=${sizes[0]}`
})

check('PE 头 + NSIS 签名', () => {
  const buf = fs.readFileSync(exePath)
  assert(buf.subarray(0, 2).toString('latin1') === 'MZ', 'exe 缺少 MZ 头，不是 PE 文件')
  assert(
    buf.toString('latin1').includes('Nullsoft'),
    'exe 里找不到 Nullsoft 串，可能不是 NSIS 安装包'
  )
  return 'MZ + Nullsoft'
})

if (process.platform !== 'win32') {
  warn('VersionInfo', '非 Windows 平台，跳过 PowerShell 版本信息校验')
} else {
  check('VersionInfo 版本号', () => {
    const script = `$i = (Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo; [Console]::Out.Write("$($i.ProductName)|$($i.ProductVersion)|$($i.FileVersion)")`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8'
    }).trim()
    const [productName, productVersion, fileVersion] = out.split('|')
    assert(productName === 'ChatAnyTime', `ProductName=${productName} ≠ ChatAnyTime`)
    assert(
      productVersion.startsWith(VERSION),
      `ProductVersion=${productVersion} 不以 ${VERSION} 开头`
    )
    return `${productName} ${productVersion}（FileVersion ${fileVersion}）`
  })
}

// ------------------------------------------------------------------- asar 层
if (!fs.existsSync(ASAR)) {
  results.push({ level: 'FAIL', name: 'asar 存在', detail: `缺少 ${ASAR}` })
} else {
  check('asar 内 package.json 版本', () => {
    const version = asarJson(ASAR, 'package.json').version
    assert(version === VERSION, `asar 内 version=${version} ≠ 期望 ${VERSION}`)
    return version
  })

  check('asar 内 pi 依赖版本 = lock 锁定版本', () => {
    const { versions } = piExpectations()
    const found = new Map()
    const nested = []
    for (const entry of require('@electron/asar').listPackage(ASAR)) {
      const parts = relParts(entry)
      if (parts[parts.length - 1] !== 'package.json') continue
      if (parts[parts.length - 3] !== '@earendil-works') continue
      const name = parts[parts.length - 2]
      const version = JSON.parse(asarRead(ASAR, ...parts).toString('utf8')).version
      if (parts.length > 4) nested.push(name)
      const seen = found.get(name)
      assert(
        !seen || seen === version,
        `包内 @earendil-works/${name} 有多个版本：${seen} / ${version}`
      )
      found.set(name, version)
    }
    assert(found.size > 0, 'asar 里找不到任何 @earendil-works 包')
    const bad = []
    for (const [name, want] of versions) {
      if (!found.has(name)) {
        bad.push(`${name} 没进包`)
        continue
      }
      if (found.get(name) !== want) bad.push(`${name}: 包内 ${found.get(name)} ≠ 期望 ${want}`)
    }
    for (const [name] of found) {
      if (!versions.has(name)) bad.push(`${name} 不在 lock 里`)
    }
    assert(bad.length === 0, bad.join('; '))
    const list = [...found].map(([n, v]) => `${n}@${v}`).join(', ')
    return `${found.size} 个：${list}${nested.length ? `（含 ${nested.length} 处嵌套）` : ''}`
  })

  if (skip.has('compare')) {
    warn('asar ↔ out 逐文件比对', '已按 --skip=compare 跳过')
  } else {
    check('asar ↔ out 逐文件 sha256 比对', () => {
      const asar = require('@electron/asar')
      // listPackage 同时返回目录条目，得先把它们剔掉（否则会出现「包里有 out、out/main」这种假阳性）
      const all = asar.listPackage(ASAR).map(relParts).map((parts) => parts.join('/'))
      const dirs = new Set()
      for (const p of all) {
        let idx = p.indexOf('/')
        while (idx !== -1) {
          dirs.add(p.slice(0, idx))
          idx = p.indexOf('/', idx + 1)
        }
      }
      const entries = all.filter((p) => p.startsWith('out/') && !dirs.has(p))
      assert(entries.length > 0, 'asar 里没有 out/** 文件条目')
      const localDir = path.join(ROOT, 'out')
      assert(fs.existsSync(localDir), '本地缺少 out/ 构建产物')
      const local = walk(localDir)
      const inPkg = entries.map((p) => p.slice('out/'.length))
      // electron-builder 会过滤掉类型声明（实测 vditor 的 113 个 .d.ts 不进包，运行时不需要）：
      // 它们只记录不报错；真正的同名断言方向是「包里的文件必须与本地一致」。
      const typeOnly = (p) => /\.d\.ts$/.test(p)
      const missing = local.filter((p) => !inPkg.includes(p))
      const missingCode = missing.filter((p) => !typeOnly(p))
      const extra = inPkg.filter((p) => !local.includes(p))
      const diff = []
      for (const rel of inPkg) {
        if (extra.includes(rel)) continue
        const inAsar = asar.extractFile(ASAR, path.join('out', ...rel.split('/')))
        const onDisk = fs.readFileSync(path.join(localDir, ...rel.split('/')))
        if (inAsar.length !== onDisk.length || sha256(inAsar) !== sha256(onDisk)) diff.push(rel)
      }
      const problems = [
        missingCode.length
          ? `out/ 有 ${missingCode.length} 个文件没进包：${missingCode.slice(0, 3).join(', ')}`
          : '',
        extra.length ? `包里有 ${extra.length} 个文件不在 out/：${extra.slice(0, 3).join(', ')}` : '',
        diff.length ? `${diff.length} 个文件内容不一致：${diff.slice(0, 3).join(', ')}` : ''
      ].filter(Boolean)
      assert(problems.length === 0, problems.join('；'))
      return `${inPkg.length} 个文件逐一比对一致${
        missing.length ? `（另有 ${missing.length} 个 .d.ts 类型声明未进包，正常）` : ''
      }`
    })
  }
}

// ------------------------------------------------------- extraResources 资产
const REQUIRED_SKILLS = [
  'automation/SKILL.md',
  'computer-use/SKILL.md',
  'computer-use/ljqCtrl.py',
  'computer-use/uia.py',
  'computer-use/ui_detect.py',
  'computer-use/test/selfcheck.py',
  'web-tasks/SKILL.md'
]
const REQUIRED_SUBAGENTS = [
  'code-reviewer.json',
  'explorer.json',
  'general-purpose.json'
]

check('内置 skill / subagent 资产齐备', () => {
  const skillsDir = path.join(UNPACKED, 'resources', 'skills')
  const subsDir = path.join(UNPACKED, 'resources', 'subagents')
  assert(fs.existsSync(skillsDir), `缺少 ${skillsDir}（win-unpacked 未产出？）`)
  assert(fs.existsSync(subsDir), `缺少 ${subsDir}`)
  const missing = [
    ...REQUIRED_SKILLS.filter((p) => !fs.existsSync(path.join(skillsDir, ...p.split('/')))).map(
      (p) => `skills/${p}`
    ),
    ...REQUIRED_SUBAGENTS.filter((p) => !fs.existsSync(path.join(subsDir, p))).map(
      (p) => `subagents/${p}`
    )
  ]
  assert(missing.length === 0, `缺少：${missing.join(', ')}`)
  return `skills ${REQUIRED_SKILLS.length} 个关键文件 + subagents ${REQUIRED_SUBAGENTS.length} 份`
})

check('资产里没有 __pycache__ / .pyc 残留', () => {
  const offenders = []
  for (const sub of ['skills', 'subagents']) {
    const dir = path.join(UNPACKED, 'resources', sub)
    if (!fs.existsSync(dir)) continue
    for (const rel of walk(dir)) {
      const parts = rel.split('/')
      if (parts.includes('__pycache__') || rel.endsWith('.pyc')) offenders.push(`${sub}/${rel}`)
    }
  }
  assert(offenders.length === 0, `发现 ${offenders.length} 个：${offenders.slice(0, 5).join(', ')}`)
  return '0 个残留'
})

// --------------------------------------------------------------------- 汇总
function report() {
  const icon = { PASS: '✓', FAIL: '✗', WARN: '!' }
  console.log(`\n安装包静态校验（版本 ${VERSION}，${new Date().toISOString()}）`)
  console.log('─'.repeat(78))
  for (const r of results) {
    console.log(`${icon[r.level]} ${pad(r.name, 42)} ${r.detail}`)
  }
  const failed = results.filter((r) => r.level === 'FAIL').length
  console.log('─'.repeat(78))
  console.log(
    `通过 ${results.filter((r) => r.level === 'PASS').length} / 警告 ${
      results.filter((r) => r.level === 'WARN').length
    } / 失败 ${failed}`
  )
  if (failed > 0) {
    console.log('\n校验未通过，详见上方 ✗ 行。')
    process.exitCode = 1
  }
}

// 走到这里说明是完整校验（--preinstall 分支已在上面 exit）
report()
