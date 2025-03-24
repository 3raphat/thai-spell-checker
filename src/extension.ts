import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

// Dictionary for Thai words
const thaiDictionary: Set<string> = new Set()
let diagnosticCollection: vscode.DiagnosticCollection
let isInitialized = true
let statusBarItem: vscode.StatusBarItem

const segmentationCache: Map<string, boolean> = new Map()

function containsThai(text: string): boolean {
  const thaiPattern = /[\u0E00-\u0E7F]/
  return thaiPattern.test(text)
}

function canSegment(word: string): boolean {
  if (segmentationCache.has(word)) {
    return segmentationCache.get(word) as boolean
  }

  if (thaiDictionary.has(word)) {
    segmentationCache.set(word, true)
    return true
  }

  const n = word.length
  const dp = new Array(n + 1).fill(false)
  dp[0] = true // Empty string is valid

  for (let i = 1; i <= n; i++) {
    for (let j = 0; j < i; j++) {
      if (dp[j] && thaiDictionary.has(word.substring(j, i))) {
        dp[i] = true
        break
      }
    }
  }

  segmentationCache.set(word, dp[n])
  return dp[n]
}

async function loadDictionary(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  try {
    const extensionPath = context.extensionPath
    const possiblePaths = [
      path.join(__dirname, "wordlist.json"),
      path.join(extensionPath, "dist", "wordlist.json"),
      path.join(extensionPath, "src", "wordlist.json"),
    ]

    let fileData = ""

    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        fileData = fs.readFileSync(testPath, "utf8")
        break
      }
    }

    if (!fileData) {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (workspaceFolders && workspaceFolders.length > 0) {
        const possibleWorkspacePaths = [
          path.join(workspaceFolders[0].uri.fsPath, "dist", "wordlist.json"),
          path.join(workspaceFolders[0].uri.fsPath, "src", "wordlist.json"),
        ]

        for (const workspaceFilePath of possibleWorkspacePaths) {
          if (fs.existsSync(workspaceFilePath)) {
            fileData = fs.readFileSync(workspaceFilePath, "utf8")
            break
          }
        }
      }
    }

    if (!fileData) {
      throw new Error("Could not find wordlist.json file")
    }

    const wordlist = JSON.parse(fileData)
    if (!Array.isArray(wordlist)) {
      throw new Error("Wordlist should be an array of strings")
    }

    thaiDictionary.clear()
    segmentationCache.clear()

    // Add base dictionary words
    wordlist
      .filter(
        (word) => typeof word === "string" && word.trim() && containsThai(word),
      )
      .forEach((word) => thaiDictionary.add(word.trim()))

    if (thaiDictionary.size === 0) {
      throw new Error("No valid Thai words found in the dictionary")
    }

    // Load custom words from settings
    const customWords = vscode.workspace
      .getConfiguration("thai-spell-check")
      .get<string[]>("customWords", [])

    // Add custom words to dictionary
    customWords
      .filter(
        (word) => typeof word === "string" && word.trim() && containsThai(word),
      )
      .forEach((word) => thaiDictionary.add(word.trim()))

    updateStatusBar()
    isInitialized = true
    return true
  } catch (error) {
    isInitialized = false
    vscode.window.showErrorMessage(
      `Thai dictionary error: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
    updateStatusBar()
    return false
  }
}

function extractThaiWords(
  text: string,
): { word: string; startPos: number; endPos: number }[] {
  if (!text || !containsThai(text)) {
    return []
  }

  const words: { word: string; startPos: number; endPos: number }[] = []
  let inThai = false
  let currentWord = ""
  let wordStart = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const isThai = containsThai(char)

    if (isThai) {
      if (!inThai) {
        inThai = true
        currentWord = char
        wordStart = i
      } else {
        currentWord += char
      }
    } else if (inThai) {
      words.push({ word: currentWord, startPos: wordStart, endPos: i })
      inThai = false
      currentWord = ""
    }
  }

  if (inThai && currentWord) {
    words.push({ word: currentWord, startPos: wordStart, endPos: text.length })
  }

  return words
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length

  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) {
    dp[i][0] = i
  }

  for (let j = 0; j <= n; j++) {
    dp[0][j] = j
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      )
    }
  }

  return dp[m][n]
}

function suggestCorrections(word: string): string[] {
  const suggestions: { word: string; distance: number }[] = []
  const wordLen = word.length

  Array.from(thaiDictionary)
    .filter((dictWord) => Math.abs(dictWord.length - wordLen) <= 2)
    .forEach((dictWord) => {
      const distance = levenshteinDistance(word, dictWord)
      // Only include words with reasonable distance
      if (distance <= 2) {
        suggestions.push({ word: dictWord, distance })
      }
    })

  // Sort by distance (closest first)
  suggestions.sort((a, b) => a.distance - b.distance)

  // Limit to top 5 suggestions
  return suggestions.slice(0, 5).map((s) => s.word)
}

function checkDocumentSpelling(document: vscode.TextDocument) {
  if (!isInitialized || thaiDictionary.size === 0) {
    return
  }

  const text = document.getText()
  if (!containsThai(text)) {
    diagnosticCollection.set(document.uri, [])
    return
  }

  const thaiWords = extractThaiWords(text)
  const diagnostics = createDiagnostics(document, thaiWords)

  diagnosticCollection.set(document.uri, diagnostics)
  updateStatusBar(diagnostics.length)
}

function createDiagnostics(
  document: vscode.TextDocument,
  thaiWords: { word: string; startPos: number; endPos: number }[],
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []

  for (const wordInfo of thaiWords) {
    // Skip very short words
    if (wordInfo.word.length < 2) {
      continue
    }

    // Skip words in dictionary or those that can be segmented
    if (thaiDictionary.has(wordInfo.word) || canSegment(wordInfo.word)) {
      continue
    }

    const range = new vscode.Range(
      document.positionAt(wordInfo.startPos),
      document.positionAt(wordInfo.endPos),
    )

    const diagnostic = new vscode.Diagnostic(
      range,
      `Unknown Thai word: "${wordInfo.word}"`,
      vscode.DiagnosticSeverity.Information,
    )

    diagnostic.source = "Thai Spell Check"
    diagnostic.code = "thai-unknown-word"

    const suggestions = suggestCorrections(wordInfo.word)
    if (suggestions.length > 0) {
      diagnostic.relatedInformation = suggestions.map(
        (suggestion) =>
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(document.uri, range),
            `Did you mean: ${suggestion}?`,
          ),
      )
    }

    diagnostics.push(diagnostic)
  }

  return diagnostics
}

function updateStatusBar(errorCount?: number) {
  if (!statusBarItem) {
    return
  }

  if (!isInitialized) {
    statusBarItem.text = "$(warning) Thai Dict: Error"
    statusBarItem.tooltip = "Thai dictionary failed to load"
    statusBarItem.show()
    return
  }

  const dictSize = thaiDictionary.size
  if (errorCount !== undefined) {
    statusBarItem.text = `$(book) Thai Dict: ${dictSize} words | $(error) ${errorCount}`
    statusBarItem.tooltip = `Thai dictionary loaded with ${dictSize} words. ${errorCount} spelling errors found.`
  } else {
    statusBarItem.text = `$(book) Thai Dict: ${dictSize} words`
    statusBarItem.tooltip = `Thai dictionary loaded with ${dictSize} words`
  }

  statusBarItem.show()
}

class ThaiSpellCheckCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const diagnostics = context.diagnostics.filter(
      (diagnostic) => diagnostic.code === "thai-unknown-word",
    )
    if (diagnostics.length === 0) {
      return []
    }

    const codeActions: vscode.CodeAction[] = []
    for (const diagnostic of diagnostics) {
      if (diagnostic.relatedInformation) {
        for (const relatedInfo of diagnostic.relatedInformation) {
          const suggestion = relatedInfo.message
            .replace("Did you mean: ", "")
            .replace("?", "")
          const replaceAction = new vscode.CodeAction(
            `Replace with "${suggestion}"`,
            vscode.CodeActionKind.QuickFix,
          )
          replaceAction.edit = new vscode.WorkspaceEdit()
          replaceAction.edit.replace(document.uri, diagnostic.range, suggestion)
          codeActions.push(replaceAction)
        }
      }

      const word = diagnostic.message.split('"')[1]
      const addCustomWordAction = new vscode.CodeAction(
        `Add "${word}" to dictionary`,
        vscode.CodeActionKind.QuickFix,
      )
      addCustomWordAction.command = {
        title: "Add Custom Word",
        command: "thai-spell-check.addCustomWordInline",
        arguments: [word],
      }
      codeActions.push(addCustomWordAction)
    }
    return codeActions
  }
}

export async function activate(context: vscode.ExtensionContext) {
  diagnosticCollection =
    vscode.languages.createDiagnosticCollection("thai-spelling")
  context.subscriptions.push(diagnosticCollection)

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  )
  context.subscriptions.push(statusBarItem)

  statusBarItem.text = "$(loading~spin) Loading Thai Dictionary..."
  statusBarItem.show()

  const loaded = await loadDictionary(context)
  if (!loaded) {
    vscode.window.showErrorMessage(
      "Failed to load Thai dictionary. Spelling checks may not work correctly.",
    )
  }

  const configChangeListener = vscode.workspace.onDidChangeConfiguration(
    async (e) => {
      if (e.affectsConfiguration("thai-spell-check.customWords")) {
        statusBarItem.text = "$(loading~spin) Reloading Dictionary..."
        statusBarItem.show()
        await loadDictionary(context)

        // Refresh diagnostics in active editor
        if (vscode.window.activeTextEditor) {
          checkDocumentSpelling(vscode.window.activeTextEditor.document)
        }
      }
    },
  )

  context.subscriptions.push(configChangeListener)

  const docChangeListener = vscode.workspace.onDidChangeTextDocument(
    (event) => {
      if (isInitialized) {
        checkDocumentSpelling(event.document)
      }
    },
  )

  const docOpenListener = vscode.workspace.onDidOpenTextDocument((document) => {
    if (isInitialized) {
      checkDocumentSpelling(document)
    }
  })

  context.subscriptions.push(docChangeListener, docOpenListener)

  if (vscode.window.activeTextEditor) {
    checkDocumentSpelling(vscode.window.activeTextEditor.document)
  }

  const reloadCommand = vscode.commands.registerCommand(
    "thai-spell-check.reloadDictionary",
    async () => {
      statusBarItem.text = "$(loading~spin) Reloading Thai Dictionary..."
      statusBarItem.show()

      if ((await loadDictionary(context)) && vscode.window.activeTextEditor) {
        checkDocumentSpelling(vscode.window.activeTextEditor.document)
      }
    },
  )

  const addCustomWordInlineCommand = vscode.commands.registerCommand(
    "thai-spell-check.addCustomWordInline",
    async (word: string) => {
      if (word && containsThai(word)) {
        const config = vscode.workspace.getConfiguration("thai-spell-check")
        const customWords = config.get<string[]>("customWords", [])
        customWords.push(word.trim())
        await config.update(
          "customWords",
          customWords,
          vscode.ConfigurationTarget.Global,
        )
        await loadDictionary(context)
        if (vscode.window.activeTextEditor) {
          checkDocumentSpelling(vscode.window.activeTextEditor.document)
        }
        vscode.window.showInformationMessage(
          `"${word.trim()}" added to dictionary.`,
        )
      } else {
        vscode.window.showErrorMessage("Invalid Thai word.")
      }
    },
  )

  context.subscriptions.push(reloadCommand, addCustomWordInlineCommand)

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "*" },
      new ThaiSpellCheckCodeActionProvider(),
    ),
  )
}

export function deactivate() {
  if (diagnosticCollection) {
    diagnosticCollection.clear()
    diagnosticCollection.dispose()
  }
  if (statusBarItem) {
    statusBarItem.dispose()
  }
  thaiDictionary.clear()
  segmentationCache.clear()
  isInitialized = false
}
