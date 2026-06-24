import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import {
  initDb,
  profileGet, profileUpsert,
  settingGet, settingSet,
  symptomInsert, symptomGetAll, symptomUpdate, symptomDelete,
  labInsert, labGetAll, labUpdate, labDelete,
  medicationInsert, medicationGetAll, medicationUpdate, medicationDelete,
  connectionInsert, connectionGetAll
} from './db.js'
import { extractPdfText, parseLabText, extractDrawDate, parsePromethease, parse23andMe } from './upload.js'
import { aggregateForAnalysis, runAnalysis } from './claude.js'

// ── API key ───────────────────────────────────────────────────────────────────
// Advocate is free for all users. The API key is managed by the app.
// Replace with your actual Anthropic API key before building for distribution.
const ADVOCATE_API_KEY = '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'

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#F9F7F4',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await initDb()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpcHandlers() {
  ipcMain.handle('profile:get', () => profileGet())
  ipcMain.handle('profile:upsert', (_, data) => profileUpsert(data))

  ipcMain.handle('setting:get', (_, key) => settingGet(key))
  ipcMain.handle('setting:set', (_, key, value) => settingSet(key, value))

  ipcMain.handle('symptom:insert', (_, data) => symptomInsert(data))
  ipcMain.handle('symptom:getAll', () => symptomGetAll())
  ipcMain.handle('symptom:update', (_, id, data) => symptomUpdate(id, data))
  ipcMain.handle('symptom:delete', (_, id) => symptomDelete(id))

  ipcMain.handle('lab:insert', (_, data) => labInsert(data))
  ipcMain.handle('lab:getAll', () => labGetAll())
  ipcMain.handle('lab:update', (_, id, data) => labUpdate(id, data))
  ipcMain.handle('lab:delete', (_, id) => labDelete(id))

  ipcMain.handle('medication:insert', (_, data) => medicationInsert(data))
  ipcMain.handle('medication:getAll', () => medicationGetAll())
  ipcMain.handle('medication:update', (_, id, data) => medicationUpdate(id, data))
  ipcMain.handle('medication:delete', (_, id) => medicationDelete(id))

  ipcMain.handle('connection:insert', (_, data) => connectionInsert(data))
  ipcMain.handle('connection:getAll', () => connectionGetAll())

  ipcMain.handle('dialog:openFile', async (_, options) => {
    const result = await dialog.showOpenDialog(options)
    return result
  })

  ipcMain.handle('upload:parseLabs', async (_, filePath, labDictionary) => {
    const { text, error } = await extractPdfText(filePath)
    if (error) return { results: [], draw_date: null, error }
    const results = parseLabText(text, labDictionary)
    const draw_date = extractDrawDate(text)
    return { results, draw_date, rawText: text, error: null }
  })

  ipcMain.handle('upload:parseGenetic', async (_, filePath, fileType) => {
    try {
      const content = readFileSync(filePath, 'utf8')
      if (fileType === 'promethease') {
        return { variants: parsePromethease(content), error: null }
      } else if (fileType === '23andme') {
        return { variants: parse23andMe(content), error: null }
      }
      return { variants: [], error: 'Unknown file type' }
    } catch (err) {
      return { variants: [], error: err.message }
    }
  })

  ipcMain.handle('upload:readFile', (_, filePath) => {
    try {
      return { content: readFileSync(filePath, 'utf8'), error: null }
    } catch (err) {
      return { content: '', error: err.message }
    }
  })

  ipcMain.handle('report:exportPdf', async (_, html) => {
    try {
      const tmpPath = join(app.getPath('temp'), 'advocate-report.html')
      writeFileSync(tmpPath, html, 'utf8')

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Health Report',
        defaultPath: join(app.getPath('documents'), `health-report-${new Date().toISOString().slice(0, 10)}.pdf`),
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      })
      if (canceled || !filePath) return { ok: false }

      const win = new BrowserWindow({ show: false, webPreferences: { javascript: true } })
      await win.loadFile(tmpPath)
      await new Promise(r => setTimeout(r, 800))
      const pdfBuffer = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
      })
      win.close()
      writeFileSync(filePath, pdfBuffer)
      shell.showItemInFolder(filePath)
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('claude:analyze', async () => {
    try {
      const [profile, labs, symptoms, medications] = await Promise.all([
        profileGet(),
        labGetAll(),
        symptomGetAll(),
        medicationGetAll(),
      ])

      const aggregated = aggregateForAnalysis({
        profile,
        labs: labs || [],
        symptoms: symptoms || [],
        medications: medications || []
      })

      const result = await runAnalysis(ADVOCATE_API_KEY, aggregated)

      await settingSet('last_analysis_text',     result.text         || '')
      await settingSet('last_analysis_patient',  result.patient_text || result.text || '')
      await settingSet('last_analysis_provider', result.provider_text || '')
      await settingSet('last_analysis_date',     result.generated_at)
      await settingSet('last_analysis_model',    result.model)

      return { result, error: null }
    } catch (err) {
      return { result: null, error: err.message }
    }
  })
}
