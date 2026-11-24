import { BrowserWindow, ipcMain, shell } from 'electron'
import { readdir, lstat, realpath, rm, link, rename } from 'fs/promises'
import { createReadStream } from 'fs'
import type { BigIntStats } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join, extname, isAbsolute } from 'path'
import { IPC } from '../../shared/channels'
import type {
  DuplicateScanOptions,
  DuplicateFile,
  DuplicateGroup,
  DuplicateScanResult,
  DuplicateScanProgress,
  DuplicateDeleteMode,
  DuplicateDeleteResult,
  DuplicateProtectionKind
} from '../../shared/types'
import type { WindowGetter } from './index'
import { showOpenDialog } from './open-dialog'
import {
  isExcluded,
  isExcludedResolved,
  resolveScanRoot,
  expandExclusions
} from '../services/file-utils'
import { getSettings } from '../services/settings-store'

let cancelled = false
// Overlapping deletions could each see the other's target as the surviving copy.
let deleting = false

/**
 * The last scan's groups, kept in the main process so deletion is judged against
 * what was actually found rather than whatever paths the renderer sends.
 * Members are listed in result order; successfully deleted members are dropped.
 */
interface ScannedGroup {
  fullHash: string
  size: number
  paths: string[]
  /** Each member's file identity at scan time; ino 0 means the filesystem gave none. */
  identities: Map<string, FileIdentity>
  /** Paths marked protected at scan time (game audio banks, game assets, app binaries). */
  protectedPaths: Set<string>
}

interface FileIdentity {
  dev: bigint
  ino: bigint
}

/** What the walk records about the files it found. */
interface WalkRecord {
  /** Paths whose inode has other hard links, outside the scan or collapsed within it. */
  linked: Set<string>
  /** dev:ino of files already listed, so hard links collapse into one candidate. */
  seen: Set<string>
  identities: Map<string, FileIdentity>
}
const scannedGroups = new Map<string, ScannedGroup>()

// ── Game, Audio & Application Asset Protection ──

const GAME_AUDIO_EXTENSIONS = new Set([
  '.bank', // FMOD Studio sound banks (Assetto Corsa, ACC, ETS2, ATS, Forza, etc.)
  '.fsb', // FMOD SoundBank
  '.fev', // FMOD Events
  '.bnk', // Wwise SoundBank
  '.wem', // Wwise Encoded Media
  '.pck', // Wwise / Godot Audio Package
  '.xwb', // Microsoft XACT Wave Bank
  '.xsb', // Microsoft XACT Sound Bank
  '.xgs', // Microsoft XACT Global Settings
  '.acb', // CRIWARE Audio Cue Sheet
  '.awb', // CRIWARE Audio Wave Bank
  '.hca', // CRIWARE High Compression Audio
  '.adx', // CRIWARE ADX Audio
  '.sab', // Square Enix Sound Asset
  '.mab' // Square Enix Music Asset
])

const GAME_ASSET_EXTENSIONS = new Set([
  '.kn5', // Assetto Corsa 3D Model
  '.acd', // Assetto Corsa Packed Car Data
  '.acreplay',
  '.lut', // Assetto Corsa physics/graphics LUT curves
  '.pak', // Unreal / Quake / CryEngine Package
  '.vpk', // Source Engine Valve Pak
  '.wad', // Doom / Half-Life WAD
  '.assets', // Unity Assets
  '.ress', // Unity Resource Stream
  '.resource', // Unity Audio/Video Resource
  '.bundle', // Unity AssetBundle
  '.upk', // Unreal Package
  '.uasset', // Unreal Asset
  '.umap', // Unreal Map
  '.uexp', // Unreal Export
  '.ubulk', // Unreal Bulk Data
  '.ucas', // Unreal IoStore Container
  '.utoc', // Unreal IoStore Table of Contents
  '.bsa', // Bethesda Softworks Archive
  '.ba2', // Bethesda Archive v2
  '.esm', // Elder Scrolls Master
  '.esp', // Elder Scrolls Plugin
  '.esl', // Elder Scrolls Light Plugin
  '.rpf', // Rockstar RAGE Package File
  '.scs', // SCS Software Archive
  '.big', // EA BIG Archive
  '.mpq', // Blizzard MoPaQ
  '.xp3', // KiriKiri Package
  '.arz', // Grim Dawn / Titan Quest Database
  '.arc', // Game Archive
  '.mas', // rFactor 2 MAS Archive
  '.dds', // DirectDraw Surface Texture
  '.vtf', // Valve Texture Format
  '.vmt', // Valve Material Type
  '.ktx', // Khronos Texture
  '.cso', // Compiled Shader Object
  '.fxc', // DirectX Effect Shader
  '.dxbc', // DirectX Bytecode
  '.dxil', // DirectX Intermediate Language
  '.spv', // SPIR-V Shader
  '.shadercache',
  '.pso' // Pipeline State Object
])

const APP_BINARY_EXTENSIONS = new Set([
  '.dll',
  '.exe',
  '.sys',
  '.drv',
  '.ocx',
  '.so',
  '.dylib',
  '.asi',
  '.cleo',
  '.pyd',
  '.node',
  '.wasm',
  '.mui',
  '.cat',
  '.manifest',
  '.tlb',
  '.pdb'
])

const GAME_AUDIO_FILENAMES = new Set([
  'guids.txt', // FMOD event GUID table required in every Assetto Corsa car sfx folder
  'cm_sfx_guids.txt',
  'audio.ini',
  'sfx.ini',
  'sounds.ini'
])

const GAME_CRITICAL_FILENAMES = new Set([
  'ui_car.json',
  'ui_track.json',
  'ui_skin.json',
  'ext_config.ini',
  'engine.ini',
  'cameras.ini',
  'tyres.ini',
  'suspensions.ini',
  'drivetrain.ini',
  'aero.ini',
  'car.ini',
  'lods.ini',
  'surfaces.ini',
  'crew.ini',
  'driver3d.ini',
  'flame_presets.ini',
  'lights.ini',
  'mirrors.ini',
  'proview_nodes.ini',
  'script.ini',
  'setup.ini',
  'shadows.ini',
  'wing_animations.ini'
])

const GAME_DIRECTORY_SEGMENTS = new Set([
  'assettocorsa',
  'assetto corsa',
  'assetto corsa competizione',
  'steamapps',
  'steamlibrary',
  'epic games',
  'gog games',
  'ubisoft game launcher',
  'ea games',
  'origin games',
  'riot games',
  'xboxgames',
  'windowsapps',
  'battle.net',
  'streamingassets',
  'gamedata',
  'shadercache'
])

const DedicatedAudioSubfolders = new Set(['sfx', 'fmod', 'wwise', 'soundbanks'])
const GeneralAudioSubfolders = new Set([
  'sfx',
  'sound',
  'sounds',
  'audio',
  'voice',
  'voices',
  'music',
  'bgm',
  'fmod',
  'wwise',
  'soundbanks'
])
const MediaAudioExts = new Set(['.wav', '.ogg', '.mp3', '.flac', '.aac', '.wma', '.opus'])

/**
 * Classifies whether a path belongs to a game audio bank, game asset,
 * application binary, or game directory that could break software if deleted.
 */
export function detectFileProtection(filePath: string): DuplicateProtectionKind | undefined {
  const baseName = basename(filePath).toLowerCase()
  const ext = extname(baseName).toLowerCase()
  const normalized = filePath.toLowerCase().replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  const dirSegments = segments.slice(0, -1)

  if (GAME_AUDIO_EXTENSIONS.has(ext) || GAME_AUDIO_FILENAMES.has(baseName)) {
    return 'game-audio'
  }

  const inDedicatedAudioDir = dirSegments.some((s) => DedicatedAudioSubfolders.has(s))
  if (inDedicatedAudioDir) {
    return 'game-audio'
  }

  const inGameDir =
    dirSegments.some((s) => GAME_DIRECTORY_SEGMENTS.has(s)) ||
    normalized.includes('/content/cars/') ||
    normalized.includes('/content/tracks/') ||
    normalized.includes('/content/sfx/') ||
    normalized.includes('/extension/lua/') ||
    normalized.includes('/extension/shaders/')

  if (
    inGameDir &&
    (MediaAudioExts.has(ext) || dirSegments.some((s) => GeneralAudioSubfolders.has(s)))
  ) {
    return 'game-audio'
  }

  if (GAME_ASSET_EXTENSIONS.has(ext) || GAME_CRITICAL_FILENAMES.has(baseName)) {
    return 'game-asset'
  }

  if (APP_BINARY_EXTENSIONS.has(ext)) {
    return 'app-binary'
  }

  if (inGameDir) {
    return 'game-directory'
  }

  return undefined
}

/**
 * Normalizes a filename by stripping common duplicate suffixes such as
 * " (1)", " - Copy", " - copia", "_copy" so true user copies match the original stem,
 * while distinct component names (e.g. "bmw_m3.bank" vs "honda_ep3.bank") remain distinct.
 */
export function normalizeDuplicateStem(filePath: string): string {
  const base = basename(filePath)
  const ext = extname(base)
  let stem = (ext ? base.slice(0, -ext.length) : base).toLowerCase().trim()
  let prev = ''
  while (stem !== prev) {
    prev = stem
    stem = stem
      .replace(/\s*\(\d+\)$/, '')
      .replace(/[\s_-]+(?:copy|copia|duplicado|duplicate)(?:[\s_-]*\d+)?$/i, '')
      .trim()
  }
  return `${stem}${ext.toLowerCase()}`
}

// ── Progress helpers ──

function sendProgress(win: BrowserWindow | null, data: DuplicateScanProgress): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DUPLICATES_PROGRESS, data)
  }
}

// ── Phase 1: Filesystem walk ──

async function walkDirectory(
  dirPath: string,
  options: DuplicateScanOptions,
  depth: number,
  files: DuplicateFile[],
  win: BrowserWindow | null,
  lastReport: { time: number },
  exclusions: string[],
  record: WalkRecord
): Promise<void> {
  if (cancelled) return
  if (depth > options.maxDepth) return

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return // inaccessible directory
  }

  for (const entry of entries) {
    if (cancelled) return

    const fullPath = join(dirPath, entry.name)

    // Skip symlinks and globally excluded paths (never descend into them)
    if (entry.isSymbolicLink() || isExcluded(fullPath, exclusions)) continue

    if (entry.isDirectory()) {
      // Check exclude patterns
      const shouldExclude = options.excludePatterns.some(
        (p) => entry.name === p || entry.name.toLowerCase() === p.toLowerCase()
      )
      if (shouldExclude) continue

      await walkDirectory(fullPath, options, depth + 1, files, win, lastReport, exclusions, record)
    } else if (entry.isFile()) {
      try {
        const s = await lstat(fullPath, { bigint: true })
        if (!s.isFile()) continue
        const size = Number(s.size)

        // Apply size filters
        if (size < options.minFileSize) continue
        if (options.maxFileSize !== null && size > options.maxFileSize) continue

        // Apply extension filter
        if (options.extensionFilter.length > 0) {
          const ext = extname(entry.name).toLowerCase()
          if (!options.extensionFilter.includes(ext)) continue
        }

        // Hard links share one inode: deleting one frees nothing and the "survivor"
        // is the same data, so only the first link found is a candidate. An unknown
        // inode (0) cannot establish that two paths are the same file.
        if (s.ino !== 0n) {
          const identity = `${s.dev}:${s.ino}`
          if (record.seen.has(identity)) continue
          record.seen.add(identity)
        }
        record.identities.set(fullPath, { dev: s.dev, ino: s.ino })
        if (s.nlink > 1n) record.linked.add(fullPath)

        const protectionKind =
          options.protectGameAndAppFiles !== false ? detectFileProtection(fullPath) : undefined

        files.push({
          path: fullPath,
          size,
          lastModified: Number(s.mtimeMs),
          ...(protectionKind ? { protected: true, protectionKind } : {})
        })

        // Throttled progress
        const now = Date.now()
        if (now - lastReport.time > 500) {
          lastReport.time = now
          sendProgress(win, {
            phase: 'walking',
            currentPath: fullPath,
            filesScanned: files.length,
            duplicatesFound: 0,
            reclaimableSpace: 0,
            progress: 0
          })
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }
}

// ── Phase 2: Size grouping ──

function groupBySize(files: DuplicateFile[]): Map<number, DuplicateFile[]> {
  const sizeMap = new Map<number, DuplicateFile[]>()
  for (const file of files) {
    const group = sizeMap.get(file.size)
    if (group) {
      group.push(file)
    } else {
      sizeMap.set(file.size, [file])
    }
  }

  // Remove unique sizes
  for (const [size, group] of sizeMap) {
    if (group.length < 2) sizeMap.delete(size)
  }

  return sizeMap
}

// ── Phase 3: Hashing ──

function hashFilePartial(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { start: 0, end: 4095 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function hashFileFull(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: 65536 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<(R | null)[]> {
  const results: (R | null)[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    if (cancelled) break
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map((item) => fn(item).catch(() => null)))
    results.push(...batchResults)
  }
  return results
}

async function findDuplicates(
  sizeGroups: Map<number, DuplicateFile[]>,
  win: BrowserWindow | null,
  linked: ReadonlySet<string> = new Set()
): Promise<DuplicateGroup[]> {
  // Collect all files that need partial hashing
  const filesToHash: DuplicateFile[] = []
  for (const group of sizeGroups.values()) {
    filesToHash.push(...group)
  }
  const totalToHash = filesToHash.length
  let hashed = 0

  // Phase 3a: Partial hash
  const partialHashMap = new Map<string, DuplicateFile[]>()

  const partialHashes = await processBatch(filesToHash, 8, async (file) => {
    const hash = await hashFilePartial(file.path)
    hashed++
    if (hashed % 50 === 0 || hashed === totalToHash) {
      sendProgress(win, {
        phase: 'partial-hash',
        currentPath: file.path,
        filesScanned: 0,
        duplicatesFound: 0,
        reclaimableSpace: 0,
        progress: Math.round((hashed / totalToHash) * 50),
        filesToHash: totalToHash,
        filesHashed: hashed
      })
    }
    return { file, hash }
  })

  for (const result of partialHashes) {
    if (!result) continue
    const key = `${result.file.size}:${result.hash}`
    const group = partialHashMap.get(key)
    if (group) {
      group.push(result.file)
    } else {
      partialHashMap.set(key, [result.file])
    }
  }

  // Filter to groups with 2+ partial hash matches
  const needFullHash: DuplicateFile[][] = []
  for (const group of partialHashMap.values()) {
    if (group.length >= 2) needFullHash.push(group)
  }

  if (cancelled || needFullHash.length === 0) return []

  // Phase 3b: Full hash
  const fullHashGroups: DuplicateGroup[] = []
  const fullHashFilesTotal = needFullHash.reduce((sum, g) => sum + g.length, 0)
  let fullHashed = 0

  for (const group of needFullHash) {
    if (cancelled) break

    const hashMap = new Map<string, DuplicateFile[]>()

    const hashes = await processBatch(group, 4, async (file) => {
      const hash = await hashFileFull(file.path)
      fullHashed++
      if (fullHashed % 10 === 0 || fullHashed === fullHashFilesTotal) {
        sendProgress(win, {
          phase: 'full-hash',
          currentPath: file.path,
          filesScanned: 0,
          duplicatesFound: fullHashGroups.length,
          reclaimableSpace: fullHashGroups.reduce((s, g) => s + g.reclaimableSpace, 0),
          progress: 50 + Math.round((fullHashed / fullHashFilesTotal) * 50),
          filesToHash: fullHashFilesTotal,
          filesHashed: fullHashed
        })
      }
      return { file, hash }
    })

    for (const result of hashes) {
      if (!result) continue
      const existing = hashMap.get(result.hash)
      if (existing) {
        existing.push(result.file)
      } else {
        hashMap.set(result.hash, [result.file])
      }
    }

    for (const [fullHash, files] of hashMap) {
      if (files.length >= 2) {
        // List the copy to keep first: it is the one the UI marks "Keep" and the
        // one the delete handler preserves if every copy is requested. A file with
        // other hard links comes first, since deleting it frees nothing; then a
        // protected game/audio/app asset; then the shortest path.
        files.sort(
          (a, b) =>
            Number(linked.has(b.path)) - Number(linked.has(a.path)) ||
            Number(Boolean(b.protected)) - Number(Boolean(a.protected)) ||
            a.path.length - b.path.length
        )
        for (const file of files) if (linked.has(file.path)) file.hardLinked = true
        const freeable = files.slice(1).filter((f) => !f.hardLinked).length
        const hasProtectedFiles = files.some((f) => f.protected === true)
        const stems = new Set(files.map((f) => normalizeDuplicateStem(f.path)))
        const hasDistinctNames = stems.size > 1
        fullHashGroups.push({
          hash: fullHash.slice(0, 16),
          fullHash,
          fileSize: files[0].size,
          files,
          reclaimableSpace: files[0].size * freeable,
          ...(hasProtectedFiles ? { hasProtectedFiles: true } : {}),
          ...(hasDistinctNames ? { hasDistinctNames: true } : {})
        })
      }
    }
  }

  // Sort by reclaimable space descending
  fullHashGroups.sort((a, b) => b.reclaimableSpace - a.reclaimableSpace)
  return fullHashGroups
}

// ── Deletion safety ──

/** Remembers the groups a scan found so later deletions can be checked against them. */
function rememberScan(
  groups: DuplicateGroup[],
  identities: Map<string, FileIdentity> = new Map()
): void {
  scannedGroups.clear()
  for (const group of groups) {
    const paths = group.files.map((f) => f.path)
    const protectedPaths = new Set(group.files.filter((f) => f.protected).map((f) => f.path))
    scannedGroups.set(group.fullHash, {
      fullHash: group.fullHash,
      size: group.fileSize,
      paths,
      protectedPaths,
      identities: new Map(
        paths.flatMap((path) => {
          const identity = identities.get(path)
          return identity ? [[path, identity] as const] : []
        })
      )
    })
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Whether `path` still resolves to the file the scan found there. The scan
 * walked a real (canonical) path and never followed links, so a path that now
 * resolves elsewhere has had an ancestor replaced by a link or junction, and a
 * different dev/ino means the file itself was replaced.
 */
function stillScannedFile(
  path: string,
  stats: BigIntStats,
  realPath: string,
  group: ScannedGroup
): boolean {
  if (!samePath(realPath, path)) return false
  const identity = group.identities.get(path)
  if (!identity) return false
  return identity.ino === 0n || (identity.dev === stats.dev && identity.ino === stats.ino)
}

async function hashMatches(filePath: string, fullHash: string): Promise<boolean> {
  try {
    return (await hashFileFull(filePath)) === fullHash
  } catch {
    return false
  }
}

/** Whether `path` is still a separate regular file holding the group's content. */
async function isIntactCopy(
  path: string,
  target: BigIntStats,
  targetRealPath: string,
  group: ScannedGroup,
  requireSameDevice = false
): Promise<boolean> {
  try {
    const s = await lstat(path, { bigint: true })
    if (!s.isFile() || Number(s.size) !== group.size) return false
    if (requireSameDevice && s.dev !== target.dev) return false
    if (!stillScannedFile(path, s, await realpath(path), group)) return false
    // The same file reached another way (a hard link, or a directory swapped for a
    // link) would disappear with the target, so it does not count as a survivor.
    if (s.ino !== 0n && s.dev === target.dev && s.ino === target.ino) return false
    if ((await realpath(path)) === targetRealPath) return false
    if (!(await hashMatches(path, group.fullHash))) return false
    // Hashing a large file takes a while, and a region already read could be
    // rewritten behind the stream. Only a file unchanged across the hash counts.
    const after = await lstat(path, { bigint: true })
    return (
      after.isFile() &&
      after.dev === s.dev &&
      after.ino === s.ino &&
      after.size === s.size &&
      after.mtimeNs === s.mtimeNs &&
      // ctime changes on every write and can't be set back, unlike mtime.
      after.ctimeNs === s.ctimeNs &&
      stillScannedFile(path, after, await realpath(path), group)
    )
  } catch {
    return false
  }
}

/**
 * Re-verify a file immediately before deleting or hard-linking it.
 * Returns why it must be kept, or null (with `survivorPath`) when it is still a duplicate
 * and another intact copy remains.
 */
async function reasonToKeep(
  filePath: string,
  group: ScannedGroup,
  exclusions: string[],
  deleteMode: DuplicateDeleteMode = 'recycle'
): Promise<{ reason: string | null; survivorPath?: string }> {
  if (deleteMode !== 'hardlink' && group.protectedPaths.has(filePath)) {
    return {
      reason:
        'Protected game or audio asset — use Hard Link mode to save space safely without losing game files'
    }
  }
  let target: BigIntStats
  let targetRealPath: string
  try {
    target = await lstat(filePath, { bigint: true })
    targetRealPath = await realpath(filePath)
  } catch {
    return { reason: 'File no longer exists' }
  }
  // lstat does not follow links, so a symlink swapped in here is rejected too.
  if (!target.isFile()) return { reason: 'Path is no longer a regular file' }
  // Another name keeps the data alive, so deleting this one would free nothing.
  if (target.nlink > 1n) {
    return { reason: 'Other hard links to this file exist, so deleting it would not free any space' }
  }
  if (!stillScannedFile(filePath, target, targetRealPath, group)) {
    return { reason: 'File was moved or replaced since the scan. Scan again before deleting.' }
  }
  if (Number(target.size) !== group.size || !(await hashMatches(filePath, group.fullHash))) {
    return { reason: 'File content changed since the scan. Scan again before deleting.' }
  }
  let survivorPath: string | undefined
  for (const other of group.paths) {
    if (other === filePath) continue
    // An excluded file is never opened, so it can't be verified as the copy that stays.
    if (await isExcludedResolved(other, exclusions)) continue
    if (await isIntactCopy(other, target, targetRealPath, group, deleteMode === 'hardlink')) {
      // Hashing can take a while; an exclusion added meanwhile still disqualifies it.
      if (await isExcludedResolved(other, await expandExclusions(getSettings().exclusions)))
        continue
      survivorPath = other
      break
    }
  }
  if (!survivorPath) {
    return {
      reason:
        deleteMode === 'hardlink'
          ? 'No other intact copy on the same drive remains to link against'
          : 'No other intact copy remains, so this file was kept'
    }
  }
  // Exclusions may have changed during that verification. Check them before
  // the final identity check below, so nothing slow sits between it and the delete.
  if (await isExcludedResolved(filePath, await expandExclusions(getSettings().exclusions))) {
    return { reason: 'excluded' }
  }
  // Checking survivors can take minutes on large files. Confirm the target is
  // still the exact file that was hashed before acting on its path.
  try {
    const now = await lstat(filePath, { bigint: true })
    if (
      !now.isFile() ||
      now.dev !== target.dev ||
      now.ino !== target.ino ||
      now.size !== target.size ||
      now.mtimeNs !== target.mtimeNs ||
      // A writer can restore mtime after rewriting same-size content; ctime it can't.
      now.ctimeNs !== target.ctimeNs ||
      !samePath(await realpath(filePath), targetRealPath)
    ) {
      return { reason: 'File changed while it was being verified. Scan again before deleting.' }
    }
  } catch {
    return { reason: 'File no longer exists' }
  }
  return { reason: null, survivorPath }
}

/**
 * Atomically replace `targetPath` with a filesystem hard link to `survivorPath`.
 * Both paths remain accessible at their original names and locations (so games like
 * Assetto Corsa never lose sound or assets), while occupying disk space only once.
 */
async function replaceWithHardLink(survivorPath: string, targetPath: string): Promise<void> {
  const dir = dirname(targetPath)
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tempLink = join(dir, `.kudu-hl-${suffix}`)

  // Create the hard link at a staging name first; if cross-device (EXDEV) or
  // unsupported by the filesystem, this fails before targetPath is touched.
  await link(survivorPath, tempLink)
  try {
    await rename(tempLink, targetPath)
  } catch {
    // Fallback if atomic overwrite rename is blocked on Windows: swap via backup name.
    const backupPath = join(dir, `.kudu-bak-${suffix}`)
    try {
      await rename(targetPath, backupPath)
    } catch (backupErr) {
      await rm(tempLink, { force: true }).catch(() => {})
      throw backupErr
    }
    try {
      await rename(tempLink, targetPath)
      await rm(backupPath, { force: true }).catch(() => {})
    } catch (replaceErr) {
      await rename(backupPath, targetPath).catch(() => {})
      await rm(tempLink, { force: true }).catch(() => {})
      throw replaceErr
    }
  }
}

// ── IPC registration ──

export function registerDuplicateFinderIpc(getWindow: WindowGetter): void {
  // Directory picker — Linux/macOS omit parent (see open-dialog.ts).
  ipcMain.handle(IPC.DUPLICATES_SELECT_DIR, async () => {
    const win = getWindow()
    if (!win) return null
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = await showOpenDialog(win, opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Cancel
  ipcMain.handle(IPC.DUPLICATES_CANCEL, () => {
    cancelled = true
  })

  // Scan
  ipcMain.handle(
    IPC.DUPLICATES_SCAN,
    async (_event, options: unknown): Promise<DuplicateScanResult> => {
      cancelled = false
      // A new scan always invalidates the previous scan's deletion candidates.
      rememberScan([])
      const startTime = Date.now()
      const win = getWindow()
      const emptyResult: DuplicateScanResult = {
        groups: [],
        totalDuplicates: 0,
        totalReclaimable: 0,
        totalFilesScanned: 0,
        duration: 0,
        cancelled: false
      }

      if (!options || typeof options !== 'object') return emptyResult
      const opts = options as Record<string, unknown>

      // Validate options
      const dir = typeof opts.directory === 'string' ? opts.directory : ''
      const safeOptions: DuplicateScanOptions = {
        directory: isAbsolute(dir) ? dir : '',
        minFileSize:
          typeof opts.minFileSize === 'number' && opts.minFileSize >= 0
            ? opts.minFileSize
            : 1_048_576,
        maxFileSize:
          typeof opts.maxFileSize === 'number' && opts.maxFileSize > 0 ? opts.maxFileSize : null,
        excludePatterns: Array.isArray(opts.excludePatterns)
          ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
          : [],
        extensionFilter: Array.isArray(opts.extensionFilter)
          ? (opts.extensionFilter as unknown[]).filter((e): e is string => typeof e === 'string')
          : [],
        maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
        protectGameAndAppFiles: opts.protectGameAndAppFiles !== false
      }

      const exclusions = await expandExclusions(getSettings().exclusions)
      const root = safeOptions.directory
        ? await resolveScanRoot(safeOptions.directory, exclusions)
        : null
      if (!root) return emptyResult
      safeOptions.directory = root

      // Phase 1: Walk
      const files: DuplicateFile[] = []
      const walkRecord: WalkRecord = { seen: new Set(), identities: new Map(), linked: new Set() }
      const lastReport = { time: Date.now() }
      await walkDirectory(
        safeOptions.directory,
        safeOptions,
        0,
        files,
        win,
        lastReport,
        exclusions,
        walkRecord
      )

      if (cancelled) {
        return {
          groups: [],
          totalDuplicates: 0,
          totalReclaimable: 0,
          totalFilesScanned: files.length,
          duration: Date.now() - startTime,
          cancelled: true
        }
      }

      // Phase 2: Group by size
      sendProgress(win, {
        phase: 'grouping',
        currentPath: '',
        filesScanned: files.length,
        duplicatesFound: 0,
        reclaimableSpace: 0,
        progress: 0
      })

      const sizeGroups = groupBySize(files)

      if (cancelled || sizeGroups.size === 0) {
        return {
          groups: [],
          totalDuplicates: 0,
          totalReclaimable: 0,
          totalFilesScanned: files.length,
          duration: Date.now() - startTime,
          cancelled
        }
      }

      // Phase 3: Hash
      const groups = await findDuplicates(sizeGroups, win, walkRecord.linked)
      rememberScan(groups, walkRecord.identities)

      const totalDuplicates = groups.reduce((sum, g) => sum + g.files.length - 1, 0)
      const totalReclaimable = groups.reduce((sum, g) => sum + g.reclaimableSpace, 0)

      sendProgress(win, {
        phase: 'complete',
        currentPath: '',
        filesScanned: files.length,
        duplicatesFound: totalDuplicates,
        reclaimableSpace: totalReclaimable,
        progress: 100
      })

      return {
        groups,
        totalDuplicates,
        totalReclaimable,
        totalFilesScanned: files.length,
        duration: Date.now() - startTime,
        cancelled
      }
    }
  )

  // Delete
  ipcMain.handle(
    IPC.DUPLICATES_DELETE,
    async (_event, paths: unknown, mode: unknown): Promise<DuplicateDeleteResult> => {
      if (!Array.isArray(paths)) return { deleted: 0, failed: 0, spaceRecovered: 0, errors: [] }
      if (deleting) throw new Error('A duplicate deletion is already in progress')
      deleting = true
      try {
        const safePaths = [
          ...new Set(paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p)))
        ]
        const deleteMode: DuplicateDeleteMode =
          mode === 'permanent' ? 'permanent' : mode === 'hardlink' ? 'hardlink' : 'recycle'
        const exclusions = await expandExclusions(getSettings().exclusions)

        let deleted = 0
        let failed = 0
        let spaceRecovered = 0
        const errors: { path: string; reason: string }[] = []
        const skip = (path: string, reason: string): void => {
          failed++
          errors.push({ path, reason })
        }

        // Resolve every request against the last scan, grouped so a survivor can be enforced.
        const groupByPath = new Map<string, ScannedGroup>()
        for (const group of scannedGroups.values()) {
          for (const path of group.paths) groupByPath.set(path, group)
        }
        const requested = new Map<ScannedGroup, string[]>()
        for (const filePath of safePaths) {
          // Exclusions may have changed since the scan; re-check before touching the file.
          if (await isExcludedResolved(filePath, exclusions)) {
            skip(filePath, 'excluded')
            continue
          }
          const group = groupByPath.get(filePath)
          if (!group) {
            skip(filePath, 'File is not in the current scan results. Scan again.')
            continue
          }
          const targets = requested.get(group)
          if (targets) targets.push(filePath)
          else requested.set(group, [filePath])
        }

        for (const [group, targets] of requested) {
          // Never remove every copy. If asked to, keep the first-listed remaining member
          // (the shortest path, which the UI marks "Keep") and delete the rest.
          if (group.paths.every((p) => targets.includes(p))) {
            const keep = group.paths[0]
            targets.splice(targets.indexOf(keep), 1)
            skip(keep, 'Kept as the last copy of this duplicate group')
          }

          for (const filePath of targets) {
            // Verification can take minutes on large files; it reads the exclusions
            // fresh and rechecks the target itself last, right before this delete.
            const { reason, survivorPath } = await reasonToKeep(
              filePath,
              group,
              await expandExclusions(getSettings().exclusions),
              deleteMode
            )
            if (reason || !survivorPath) {
              skip(filePath, reason || 'No other intact copy remains, so this file was kept')
              continue
            }
            try {
              if (deleteMode === 'hardlink') {
                await replaceWithHardLink(survivorPath, filePath)
              } else if (deleteMode === 'recycle') {
                await shell.trashItem(filePath)
              } else {
                await rm(filePath, { force: true })
              }
              group.paths = group.paths.filter((p) => p !== filePath)
              deleted++
              spaceRecovered += group.size
            } catch (err: any) {
              skip(filePath, err?.message || 'Unknown error')
            }
          }
        }

        return { deleted, failed, spaceRecovered, errors }
      } finally {
        deleting = false
      }
    }
  )

  // Open file location in system file manager
  ipcMain.handle(IPC.DUPLICATES_OPEN_LOCATION, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return
    shell.showItemInFolder(filePath)
  })
}
