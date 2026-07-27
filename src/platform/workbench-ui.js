(function () {
  "use strict";

  const DEFAULT_SOURCE = `public final class HelloWorkbench {
    public static void main(String[] args) {
        int total = 0;
        for (int value = 1; value <= 5; value++) {
            total += value;
        }
        System.out.println("total = " + total);
    }
}
`;

  const workbenchState = {
    activeWorkspace: "disassemble",
    compiledArtifacts: [],
    currentClassPath: null,
    originalAssembly: "",
    loadedJar: null,
    javaSourcePath: "/src/HelloWorkbench.java",
    javaSourceEditor: null,
    debugCodeEditor: null,
    launchMode: "application",
    documents: new Map(),
    activeDocumentId: null,
    documentCounter: 0,
    ignoreEditorChanges: false,
    assemblyEditorBound: null,
    openFromFileMenu: false,
    suppressClassDocumentActivation: false,
    workspaceRoots: new Set(["src", "assembly", "classes"]),
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setToolStatus(id, message, kind = "") {
    const element = byId(id);
    if (!element) return;
    element.textContent = message;
    element.className = `tool-status${kind ? ` ${kind}` : ""}`;
  }

  function setCodeOutput(id, value, emptyMessage) {
    const element = byId(id);
    if (!element) return;
    const text = value || "";
    element.textContent = text || emptyMessage;
    element.classList.toggle("empty", !text);
  }

  function createJavaEditor(id, options = {}) {
    const editor = window.ace.edit(id);
    editor.setTheme("ace/theme/monokai");
    editor.session.setMode("ace/mode/java");
    editor.session.setUseWorker(false);
    editor.setReadOnly(options.readOnly === true);
    editor.setOptions({
      fontSize: 12,
      highlightActiveLine: options.readOnly !== true,
      highlightGutterLine: options.readOnly !== true,
      showPrintMargin: false,
      tabSize: 4,
      useSoftTabs: true,
      wrap: false,
    });
    editor.renderer.setPadding(12);
    return editor;
  }

  function initializeJavaEditors() {
    workbenchState.javaSourceEditor = createJavaEditor("java-source-editor");

    const debugEditor = window.ace.edit("debug-code-editor");
    debugEditor.setTheme("ace/theme/monokai");
    debugEditor.session.setMode("ace/mode/text");
    debugEditor.setReadOnly(true);
    debugEditor.setOptions({
      fontSize: 12,
      highlightActiveLine: false,
      highlightGutterLine: false,
      showPrintMargin: false,
      wrap: false,
    });
    debugEditor.renderer.setPadding(10);
    debugEditor.setValue("Load a class, then start debugging to follow each instruction.", -1);
    debugEditor.clearSelection();
    workbenchState.debugCodeEditor = debugEditor;
    window.debugCodeEditor = debugEditor;
  }

  function basename(filePath) {
    return String(filePath || "").replace(/\\/g, "/").split("/").pop() || "Untitled";
  }

  function activeDocument() {
    return workbenchState.activeDocumentId
      ? workbenchState.documents.get(workbenchState.activeDocumentId) || null
      : null;
  }

  function logicalDocument(document) {
    if (!document || !document.sourceDocumentId) return document;
    return workbenchState.documents.get(document.sourceDocumentId) || document;
  }

  function linkedJavaDocument(document) {
    if (!document || !document.javaDocumentId) return null;
    return workbenchState.documents.get(document.javaDocumentId) || null;
  }

  function isLogicalDocumentActive(document) {
    const active = logicalDocument(activeDocument());
    return Boolean(active && document && active.id === logicalDocument(document).id);
  }

  function editorForDocument(document) {
    if (!document) return null;
    return document.kind === "java"
      ? workbenchState.javaSourceEditor
      : window.aceEditor || null;
  }

  function captureActiveDocument() {
    const document = activeDocument();
    const editor = editorForDocument(document);
    if (!document || !editor || workbenchState.ignoreEditorChanges) return;
    const wasDirty = document.dirty;
    document.content = editor.getValue();
    document.dirty = document.content !== document.savedContent;
    if (document.dirty !== wasDirty) renderDocumentTabs();
  }

  function updateDocumentChrome() {
    const document = activeDocument();
    const canSave = Boolean(document);
    byId("saveFileBtn").disabled = !canSave;
    byId("saveAsFileBtn").disabled = !canSave;
    byId("closeFileBtn").disabled = !canSave;
    byId("quickSaveBtn").disabled = !canSave;
    byId("activeDocumentPath").textContent = document
      ? `${document.path}${document.dirty ? " •" : ""}`
      : "No file open";
    if (byId("assemblyDocumentLabel")) {
      byId("assemblyDocumentLabel").textContent =
        document && document.kind !== "java" ? document.path : "No assembly file open";
    }
    if (document && document.kind !== "java") {
      byId("assembleBtn").textContent =
        document.kind === "class" ? "Save class" : "Save .j";
      byId("assembleBtn").disabled = false;
      byId("resetAssemblyBtn").disabled = false;
    }
  }

  function renderDocumentTabs() {
    const container = byId("documentTabs");
    container.innerHTML = "";
    for (const openDocument of workbenchState.documents.values()) {
      // Assembly and its generated Java representation are two editable
      // buffers for one class, not two independently opened files.
      if (openDocument.sourceDocumentId &&
          workbenchState.documents.has(openDocument.sourceDocumentId)) {
        continue;
      }
      const activeRepresentation = isLogicalDocumentActive(openDocument)
        ? activeDocument()
        : null;
      const displayedDocument = activeRepresentation || openDocument;
      const tab = window.document.createElement("div");
      tab.className = "document-tab";
      tab.dataset.documentId = openDocument.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute(
        "aria-selected",
        String(isLogicalDocumentActive(openDocument)),
      );

      const main = window.document.createElement("button");
      main.type = "button";
      main.className = "document-tab-main";
      main.textContent = basename(displayedDocument.path);
      main.title = displayedDocument.path;
      main.addEventListener("click", () => {
        const target = isLogicalDocumentActive(openDocument)
          ? activeDocument()
          : openDocument;
        activateDocument(target.id);
      });
      tab.appendChild(main);

      if (openDocument.dirty ||
          Boolean(linkedJavaDocument(openDocument) &&
            linkedJavaDocument(openDocument).dirty)) {
        const dirty = window.document.createElement("span");
        dirty.className = "document-dirty";
        dirty.title = "Unsaved changes";
        tab.appendChild(dirty);
      }

      const close = window.document.createElement("button");
      close.type = "button";
      close.className = "document-close";
      close.setAttribute("aria-label", `Close ${basename(openDocument.path)}`);
      close.textContent = "×";
      close.addEventListener("click", () => closeDocument(openDocument.id));
      tab.appendChild(close);
      container.appendChild(tab);
    }
    updateDocumentChrome();
  }

  function markActiveDocumentChanged(content) {
    const document = activeDocument();
    if (!document || workbenchState.ignoreEditorChanges) return;
    document.content = content;
    const dirty = content !== document.savedContent;
    if (document.dirty !== dirty) {
      document.dirty = dirty;
      renderDocumentTabs();
    } else {
      updateDocumentChrome();
    }
  }

  function bindAssemblyEditor() {
    if (!window.aceEditor || workbenchState.assemblyEditorBound === window.aceEditor) return;
    const editor = window.aceEditor;
    workbenchState.assemblyEditorBound = editor;
    editor.session.on("change", () => {
      const document = activeDocument();
      if (document && document.kind !== "java") {
        markActiveDocumentChanged(editor.getValue());
      }
    });
    editor.commands.addCommand({
      name: "saveActiveAssemblyDocument",
      bindKey: { win: "Ctrl-S", mac: "Command-S" },
      exec: () => saveActiveDocument(),
    });
  }

  function activateDocument(documentId, options = {}) {
    captureActiveDocument();
    const document = workbenchState.documents.get(documentId);
    if (!document) return;
    workbenchState.activeDocumentId = documentId;
    const editor = editorForDocument(document);
    if (editor) {
      workbenchState.ignoreEditorChanges = true;
      editor.setValue(document.content, -1);
      editor.clearSelection();
      workbenchState.ignoreEditorChanges = false;
    }
    if (document.kind === "java") {
      workbenchState.javaSourcePath = document.workspacePath;
      if (options.activateView !== false) activateWorkspace("compile");
    } else {
      workbenchState.currentClassPath = document.backingClassPath || null;
      if (options.activateView !== false) activateWorkspace("disassemble");
    }
    renderDocumentTabs();
  }

  function addJavaDocument(filePath, content, options = {}) {
    const workspacePath = filePath.startsWith("/")
      ? filePath
      : `/src/${filePath.replace(/^\/+/, "")}`;
    const id = `java:${workspacePath}`;
    const existing = workbenchState.documents.get(id);
    const document = existing || {
      id,
      kind: "java",
      path: workspacePath.replace(/^\/src\//, ""),
      workspacePath,
    };
    document.content = content;
    document.savedContent = options.dirty ? "" : content;
    document.dirty = Boolean(options.dirty);
    if (options.sourceDocumentId) {
      document.sourceDocumentId = options.sourceDocumentId;
    }
    workbenchState.documents.set(id, document);
    activateDocument(id, { activateView: options.activateView });
    return document;
  }

  function addAssemblyDocument(filePath, content, options = {}) {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const id = options.backingClassPath
      ? `class:${options.backingClassPath}`
      : `assembly:${normalized}`;
    const existing = workbenchState.documents.get(id);
    const document = existing || {
      id,
      kind: options.backingClassPath ? "class" : "assembly",
      path: normalized,
      workspacePath: `/assembly/${normalized}`,
      backingClassPath: options.backingClassPath || null,
    };
    document.content = content;
    document.savedContent = content;
    document.dirty = false;
    workbenchState.documents.set(id, document);
    bindAssemblyEditor();
    if (!workbenchState.suppressClassDocumentActivation) {
      activateDocument(id);
    } else {
      renderDocumentTabs();
    }
    return document;
  }

  function javaPathForAssemblyDocument(document) {
    const sourcePath = document.backingClassPath || document.path;
    const normalized = String(sourcePath)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^assembly\//, "")
      .replace(/\.(class|j)$/i, ".java");
    return `/src/${normalized}`;
  }

  async function openJavaRepresentation(document, focus = false) {
    if (!document || document.kind === "java") {
      activateWorkspace("compile", focus);
      return;
    }

    activateWorkspace("compile", focus);
    setToolStatus(
      "compileStatus",
      `Decompiling ${basename(document.path)} into its Java document…`,
    );
    workbenchState.ignoreEditorChanges = true;
    workbenchState.javaSourceEditor.setValue(
      `// Decompiling ${document.path}…`,
      -1,
    );
    workbenchState.javaSourceEditor.clearSelection();
    workbenchState.ignoreEditorChanges = false;

    try {
      captureActiveDocument();
      const bytes = document.backingClassPath
        ? await window.jvmDebug.fileProvider.readFile(document.backingClassPath)
        : assembleDocumentBytes(document);
      const source = window.JVMDebug.javaTools.decompileClass(bytes, {
        allowFallback: true,
        // The generated source replaces one class while its referenced sibling
        // classes remain loaded, so source names must retain binary linkage.
        preserveFieldNames: true,
      });
      const sourcePath = javaPathForAssemblyDocument(document);
      const sourceId = `java:${sourcePath}`;
      let sourceDocument = workbenchState.documents.get(sourceId);
      if (!sourceDocument || !sourceDocument.dirty) {
        sourceDocument = addJavaDocument(sourcePath, source, {
          activateView: false,
          sourceDocumentId: document.id,
        });
      } else {
        activateDocument(sourceDocument.id, { activateView: false });
      }
      document.javaDocumentId = sourceDocument.id;
      sourceDocument.sourceDocumentId = document.id;
      activateWorkspace("compile", focus);
      setToolStatus(
        "compileStatus",
        `${document.path} is open as ${sourceDocument.path}.`,
        "success",
      );
    } catch (error) {
      workbenchState.ignoreEditorChanges = true;
      workbenchState.javaSourceEditor.setValue(
        `// Java source is unavailable for ${document.path}.\n// ${error.message}`,
        -1,
      );
      workbenchState.javaSourceEditor.clearSelection();
      workbenchState.ignoreEditorChanges = false;
      setToolStatus("compileStatus", error.message, "error");
    }
  }

  function selectWorkspaceView(name, focus = false) {
    if (name === "compile") {
      openJavaRepresentation(activeDocument(), focus);
      return;
    }
    activateWorkspace(name, focus);
  }

  function normalizeWorkspacePath(value) {
    const entered = String(value || "").trim().replace(/\\/g, "/");
    if (!entered) throw new Error("Enter a folder path");
    const segments = entered.split("/").filter(Boolean);
    if (!segments.length) throw new Error("The workspace root already exists");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error("Folder paths cannot contain . or .. segments");
    }
    if (segments.some((segment) => /[\0:*?\"<>|]/.test(segment))) {
      throw new Error("The folder path contains an unsupported character");
    }
    return `/${segments.join("/")}`;
  }

  function workspaceParentPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    return slash > 0 ? normalized.slice(0, slash) : "/src";
  }

  function showNewFolderDialog() {
    const current = activeDocument();
    const parent = current && current.workspacePath
      ? workspaceParentPath(current.workspacePath)
      : "/src";
    byId("newFolderPath").value = `${parent}/new-folder`.replace(/\/+/g, "/");
    byId("newFolderHint").textContent = "Nested paths are created together.";
    byId("newFolderHint").className = "tool-status";
    byId("fileMenu").open = false;
    byId("newFolderDialog").showModal();
    byId("newFolderPath").focus();
    byId("newFolderPath").select();
  }

  function appendWorkspaceDirectory(workspace, parent, directoryPath, label) {
    const folder = document.createElement("details");
    folder.className = "workspace-directory";
    folder.open = directoryPath.split("/").filter(Boolean).length === 1;
    const summary = document.createElement("summary");
    summary.textContent = label;
    folder.appendChild(summary);
    const entries = workspace.readdirSync(directoryPath, { withFileTypes: true })
      .slice()
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
    if (!entries.length) {
      const empty = document.createElement("span");
      empty.className = "workspace-empty-directory";
      empty.textContent = "Empty folder";
      folder.appendChild(empty);
    }
    for (const entry of entries) {
      const entryPath = `${directoryPath}/${entry.name}`.replace(/\/+/g, "/");
      if (entry.isDirectory()) {
        appendWorkspaceDirectory(workspace, folder, entryPath, entry.name);
      } else if (entry.isFile()) {
        const file = document.createElement("button");
        file.type = "button";
        file.className = "workspace-file";
        file.textContent = entry.name;
        file.title = `Open ${entryPath}`;
        file.addEventListener("click", () => openWorkspaceFile(entryPath));
        folder.appendChild(file);
      }
    }
    parent.appendChild(folder);
  }

  function countWorkspaceEntries(workspace, directoryPath) {
    let count = 0;
    for (const entry of workspace.readdirSync(directoryPath, { withFileTypes: true })) {
      count += 1;
      if (entry.isDirectory()) {
        count += countWorkspaceEntries(
          workspace,
          `${directoryPath}/${entry.name}`.replace(/\/+/g, "/"),
        );
      }
    }
    return count;
  }

  function refreshWorkspaceTree() {
    const tree = byId("workspaceTree");
    if (!tree) return;
    tree.innerHTML = "";
    const workspace = window.jvmDebug &&
      window.jvmDebug.getFileProvider().getWorkspaceFileSystem();
    if (!workspace) {
      tree.textContent = "Save a file or create a folder to start the workspace.";
      byId("workspaceEntryCount").textContent = "0";
      return;
    }
    let visibleEntries = 0;
    for (const rootName of Array.from(workbenchState.workspaceRoots).sort()) {
      const rootPath = `/${rootName}`;
      if (!workspace.existsSync(rootPath) || !workspace.statSync(rootPath).isDirectory()) {
        continue;
      }
      visibleEntries += 1 + countWorkspaceEntries(workspace, rootPath);
      appendWorkspaceDirectory(workspace, tree, rootPath, rootName);
    }
    if (!tree.children.length) {
      tree.textContent = "The project workspace is empty.";
    }
    byId("workspaceEntryCount").textContent = String(visibleEntries);
  }

  async function openWorkspaceFile(filePath) {
    const workspace = window.jvmDebug.getFileProvider().getWorkspaceFileSystem();
    if (!workspace || !workspace.existsSync(filePath)) return;
    byId("workspaceExplorer").open = false;
    if (/\.java$/i.test(filePath)) {
      addJavaDocument(filePath, workspace.readFileSync(filePath, "utf8"));
    } else if (/\.j$/i.test(filePath)) {
      addAssemblyDocument(
        filePath.replace(/^\/assembly\//, ""),
        workspace.readFileSync(filePath, "utf8"),
      );
    } else if (/\.class$/i.test(filePath)) {
      await window.loadVirtualClass(filePath.replace(/^\/+/, ""));
    }
  }

  async function createWorkspaceFolder() {
    const hint = byId("newFolderHint");
    try {
      const folderPath = normalizeWorkspacePath(byId("newFolderPath").value);
      const workspace = await window.jvmDebug.ensureWorkspace();
      if (workspace.existsSync(folderPath)) {
        throw new Error(`${folderPath} already exists`);
      }
      workspace.mkdirSync(folderPath, { recursive: true });
      workbenchState.workspaceRoots.add(folderPath.split("/").filter(Boolean)[0]);
      refreshWorkspaceTree();
      byId("workspaceTreeStatus").textContent = `Created ${folderPath}`;
      byId("newFolderDialog").close();
      byId("workspaceExplorer").open = true;
    } catch (error) {
      hint.textContent = error.message;
      hint.className = "tool-status error";
    }
  }

  function closeDocument(documentId = workbenchState.activeDocumentId) {
    const requestedDocument = workbenchState.documents.get(documentId);
    if (!requestedDocument) return;
    captureActiveDocument();
    const document = logicalDocument(requestedDocument);
    const linkedDocument = linkedJavaDocument(document);
    const documentsToClose = [document, linkedDocument].filter(Boolean);
    if (documentsToClose.some((candidate) => candidate.dirty) &&
        !window.confirm(`Close ${basename(activeDocument().path)} without saving?`)) {
      return;
    }
    const visibleIds = Array.from(workbenchState.documents.values())
      .filter((candidate) => !candidate.sourceDocumentId ||
        !workbenchState.documents.has(candidate.sourceDocumentId))
      .map((candidate) => candidate.id);
    const index = visibleIds.indexOf(document.id);
    documentsToClose.forEach((candidate) => {
      workbenchState.documents.delete(candidate.id);
    });
    if (documentsToClose.some(
      (candidate) => candidate.id === workbenchState.activeDocumentId,
    )) {
      const remainingIds = visibleIds.filter((id) =>
        workbenchState.documents.has(id));
      const nextId = remainingIds[index] || remainingIds[index - 1] || null;
      workbenchState.activeDocumentId = null;
      if (nextId && workbenchState.documents.has(nextId)) activateDocument(nextId);
    }
    renderDocumentTabs();
  }

  function setClassSource(source) {
    const fileInput = byId("classFileInput");
    const sampleSelect = byId("sampleClassSelect");
    if (!fileInput || !sampleSelect) return;
    const sampleCatalog = byId("sampleCatalog");
    if (sampleCatalog) sampleCatalog.classList.toggle("is-hidden", source === "file");
    const jarSelect = byId("jarMainClassSelect");
    if (jarSelect) {
      jarSelect.classList.toggle(
        "is-hidden",
        source !== "file" || !jarSelect.options.length,
      );
    }
  }

  async function loadSelectedClass() {
    const selected = document.querySelector(
      'input[name="classSource"]:checked');
    if (selected && selected.value === "file") {
      const file = byId("classFileInput").files[0];
      if (!file) {
        setToolStatus("assemblyStatus", "Choose a .jar or .class file first.", "error");
        return;
      }
      if (/\.(java|j)$/i.test(file.name)) {
        await openTextFile(file);
        renderProjectSummary(file);
        return;
      }
      await window.loadClassFile();
      renderProjectSummary(file);
      return;
    }
    await window.loadSampleClass();
    renderProjectSummary(null);
  }

  function renderProjectSummary(file) {
    const summary = byId("jarProjectSummary");
    if (!summary) return;
    if (!file) {
      workbenchState.loadedJar = null;
      summary.classList.add("is-hidden");
      summary.textContent = "";
      return;
    }

    const jarInfo = /\.jar$/i.test(file.name) && window.jvmDebug
      ? window.jvmDebug.getJarInfo(file.name)
      : null;
    workbenchState.loadedJar = jarInfo ? { name: file.name, info: jarInfo } : null;
    const entry = jarInfo && jarInfo.mainClass
      ? `Entry point: ${jarInfo.mainClass}`
      : jarInfo
        ? "No Main-Class manifest entry; choose a runnable class."
        : "Standalone class";
    const count = jarInfo
      ? `${jarInfo.classFiles.length.toLocaleString()} classes · ` +
        `${jarInfo.resourceFiles.length.toLocaleString()} resources`
      : `${file.size.toLocaleString()} bytes`;
    summary.innerHTML = "";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const metadata = document.createElement("span");
    metadata.textContent = `${count} · ${entry}`;
    summary.append(name, metadata);
    summary.classList.remove("is-hidden");
  }

  async function openTextFile(file) {
    const content = await file.text();
    await window.jvmDebug.ensureWorkspace();
    if (/\.java$/i.test(file.name)) {
      const workspacePath = `/src/${file.name}`;
      window.jvmDebug.writeWorkspaceFile(workspacePath, content);
      addJavaDocument(workspacePath, content);
      setToolStatus("compileStatus", `${file.name} opened in the Java editor.`, "success");
      return;
    }
    const workspacePath = `/assembly/${file.name}`;
    window.jvmDebug.writeWorkspaceFile(workspacePath, content);
    addAssemblyDocument(file.name, content);
    setToolStatus("assemblyStatus", `${file.name} opened as assembly text.`, "success");
  }

  function newJavaDocument() {
    workbenchState.documentCounter += 1;
    const suffix = workbenchState.documentCounter === 1
      ? ""
      : String(workbenchState.documentCounter);
    const className = `Untitled${suffix}`;
    addJavaDocument(`${className}.java`, `public class ${className} {
    public static void main(String[] args) {
        System.out.println("Hello from ${className}");
    }
}
`, { dirty: true });
    byId("fileMenu").open = false;
  }

  function triggerDownload(fileName, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const link = window.document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function assembleDocumentBytes(document) {
    if (!document || document.kind === "java") {
      throw new Error("The active document is not assembly");
    }
    return window.JVMDebug.javaTools.assembleJasmin(document.content);
  }

  async function saveActiveDocument() {
    captureActiveDocument();
    const document = activeDocument();
    if (!document) return false;
    try {
      await window.jvmDebug.ensureWorkspace();
      if (document.kind === "java") {
        window.jvmDebug.writeWorkspaceFile(document.workspacePath, document.content);
        document.savedContent = document.content;
        document.dirty = false;
        setToolStatus("compileStatus", `${document.path} saved in the workspace.`, "success");
      } else if (document.kind === "class") {
        const bytes = assembleDocumentBytes(document);
        window.jvmDebug.fileProvider.virtualFS.set(document.backingClassPath, bytes);
        document.dirty = false;
        await window.loadVirtualClass(document.backingClassPath);
        setToolStatus(
          "assemblyStatus",
          `${document.backingClassPath} assembled and saved in the workspace.`,
          "success",
        );
      } else {
        window.jvmDebug.writeWorkspaceFile(document.workspacePath, document.content);
        document.savedContent = document.content;
        document.dirty = false;
        setToolStatus("assemblyStatus", `${document.path} saved as assembly text.`, "success");
      }
      refreshWorkspaceTree();
      renderDocumentTabs();
      return true;
    } catch (error) {
      setToolStatus(
        document.kind === "java" ? "compileStatus" : "assemblyStatus",
        error.message,
        "error",
      );
      return false;
    }
  }

  function suggestedSaveName(document) {
    if (!document) return "Untitled.java";
    if (document.kind === "class") return basename(document.backingClassPath);
    return basename(document.path);
  }

  function updateSaveAsHint() {
    const name = byId("saveAsName").value.trim();
    const hint = byId("saveAsHint");
    if (/\.j$/i.test(name)) {
      hint.textContent = "Assembly text will be preserved exactly, including comments.";
    } else if (/\.class$/i.test(name)) {
      hint.textContent = "Assembly will be compiled and saved as JVM bytecode.";
    } else {
      hint.textContent = "Source text will be saved without compilation.";
    }
  }

  function showSaveAsDialog() {
    captureActiveDocument();
    const document = activeDocument();
    if (!document) return;
    const dialog = byId("saveAsDialog");
    byId("saveAsName").value = suggestedSaveName(document);
    updateSaveAsHint();
    byId("fileMenu").open = false;
    dialog.showModal();
    byId("saveAsName").focus();
    byId("saveAsName").select();
  }

  async function confirmSaveAs() {
    captureActiveDocument();
    const document = activeDocument();
    const fileName = basename(byId("saveAsName").value.trim());
    if (!document || !fileName) return;
    try {
      if (/\.class$/i.test(fileName)) {
        let bytes;
        if (document.kind === "java") {
          const result = await compileSource();
          if (!result || !result.artifacts.length) return;
          bytes = result.artifacts[0].bytes;
        } else {
          bytes = assembleDocumentBytes(document);
        }
        triggerDownload(fileName, bytes, "application/java-vm");
      } else if (/\.j$/i.test(fileName)) {
        triggerDownload(fileName, document.content, "text/plain;charset=utf-8");
        await window.jvmDebug.ensureWorkspace();
        const workspacePath = `/assembly/${fileName}`;
        window.jvmDebug.writeWorkspaceFile(workspacePath, document.content);
        workbenchState.documents.delete(document.id);
        document.id = `assembly:${fileName}`;
        document.kind = "assembly";
        document.path = fileName;
        document.workspacePath = workspacePath;
        document.backingClassPath = null;
        document.savedContent = document.content;
        document.dirty = false;
        workbenchState.documents.set(document.id, document);
        workbenchState.activeDocumentId = document.id;
        activateDocument(document.id);
      } else {
        const outputName = /\.java$/i.test(fileName) ? fileName : `${fileName}.java`;
        triggerDownload(outputName, document.content, "text/x-java-source;charset=utf-8");
        if (document.kind === "java") {
          addJavaDocument(outputName, document.content);
        }
      }
      byId("saveAsDialog").close();
    } catch (error) {
      byId("saveAsHint").textContent = error.message;
      byId("saveAsHint").className = "tool-status error";
    }
  }

  function activateWorkspace(name, focus = false) {
    const panel = byId(`workspace-${name}`);
    if (!panel) return;
    workbenchState.activeWorkspace = name;
    document.querySelectorAll(".workspace-panel").forEach((candidate) => {
      candidate.hidden = candidate !== panel;
    });
    document.querySelectorAll(".workspace-tab").forEach((tab) => {
      const selected = tab.dataset.workspace === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    if (name === "run" || name === "debug") {
      const terminal = byId("xterm-container");
      const terminalSlot = byId(
        name === "debug" ? "debug-terminal-slot" : "run-terminal-slot",
      );
      if (terminal && terminalSlot && terminal.parentElement !== terminalSlot) {
        terminalSlot.appendChild(terminal);
      }
    }
    if (name === "disassemble" && window.aceEditor) {
      requestAnimationFrame(() => window.aceEditor.resize(true));
    }
    if (name === "compile" && workbenchState.javaSourceEditor) {
      requestAnimationFrame(() => workbenchState.javaSourceEditor.resize(true));
    }
    if (name === "debug" && workbenchState.debugCodeEditor) {
      requestAnimationFrame(() => {
        workbenchState.debugCodeEditor.resize(true);
        if (typeof window.fitJvmTerminal === "function") {
          window.fitJvmTerminal();
        }
      });
    }
    if (name === "run" && typeof window.fitJvmTerminal === "function") {
      requestAnimationFrame(() => window.fitJvmTerminal());
    }
    try {
      sessionStorage.setItem("java-tools.workspace", name);
    } catch (_) {
      // Storage is optional in privacy-restricted contexts.
    }
  }

  async function assembleEditedClass() {
    const action = byId("assembleBtn");
    const document = activeDocument();
    if (!document || document.kind === "java" || !window.aceEditor) return;
    action.disabled = true;
    await saveActiveDocument();
    action.disabled = false;
  }

  async function resetAssemblyEdits() {
    const document = activeDocument();
    if (!document || document.kind === "java") return;
    if (document.backingClassPath && typeof window.loadVirtualClass === "function") {
      await window.loadVirtualClass(document.backingClassPath);
      return;
    }
    document.content = document.savedContent;
    document.dirty = false;
    activateDocument(document.id);
  }

  function selectedArtifact() {
    const select = byId("compiledClassSelect");
    const index = select ? Number(select.value) : 0;
    return workbenchState.compiledArtifacts[index] || null;
  }

  function renderCompiledArtifact() {
    const artifact = selectedArtifact();
    setCodeOutput("compiler-output", artifact && artifact.jasmin,
      "Compile Java source to inspect generated JVM bytecode.");
    const loadButton = byId("loadCompiledBtn");
    const downloadButton = byId("downloadCompiledBtn");
    if (loadButton) loadButton.disabled = !artifact;
    if (downloadButton) downloadButton.disabled = !artifact;
  }

  function setCompileActionsDisabled(disabled) {
    byId("compileBtn").disabled = disabled;
    byId("compileRunBtn").disabled = disabled;
  }

  function stageCompiledArtifacts() {
    if (!window.jvmDebug) return;
    for (const artifact of workbenchState.compiledArtifacts) {
      window.jvmDebug.fileProvider.virtualFS.set(
        `${artifact.internalName}.class`,
        artifact.bytes,
      );
    }
  }

  async function compileSource(options = {}) {
    captureActiveDocument();
    const sourceDocument = activeDocument();
    const source = sourceDocument && sourceDocument.kind === "java"
      ? sourceDocument.content
      : workbenchState.javaSourceEditor.getValue();
    if (sourceDocument && sourceDocument.kind === "java") {
      workbenchState.javaSourcePath = sourceDocument.workspacePath;
    }
    const manageButtons = options.manageButtons !== false;
    if (manageButtons) setCompileActionsDisabled(true);
    setToolStatus("compileStatus", "Saving workspace source and emitting class files…");
    try {
      await window.jvmDebug.ensureWorkspace();
      window.jvmDebug.writeWorkspaceFile(workbenchState.javaSourcePath, source);
      const result = window.jvmDebug.compileWorkspace(
        [workbenchState.javaSourcePath],
        {
          sourceRoot: "/src",
          outputDir: "/classes",
          sourceLevel: "8",
        },
      );
      workbenchState.compiledArtifacts = result.artifacts;
      refreshWorkspaceTree();
      const select = byId("compiledClassSelect");
      select.innerHTML = "";
      result.artifacts.forEach((artifact, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${artifact.binaryName} · ${artifact.bytes.length} bytes`;
        select.appendChild(option);
      });
      select.classList.toggle("is-hidden", result.artifacts.length < 2);
      renderCompiledArtifact();
      setToolStatus("compileStatus",
        `${result.artifacts.length} class file${result.artifacts.length === 1 ? "" : "s"} emitted from ${workbenchState.javaSourcePath}`,
        "success");
      return result;
    } catch (error) {
      workbenchState.compiledArtifacts = [];
      renderCompiledArtifact();
      setToolStatus("compileStatus", error.message, "error");
      return null;
    } finally {
      if (manageButtons) setCompileActionsDisabled(false);
    }
  }

  async function loadCompiledClass(options = {}) {
    const artifact = selectedArtifact();
    if (!artifact || !window.jvmDebug) return null;
    const activateDisassembly = options.activateDisassembly !== false;
    const virtualPath = `${artifact.internalName}.class`;
    stageCompiledArtifacts();

    const jarSelect = byId("jarMainClassSelect");
    const useJar = workbenchState.loadedJar && jarSelect;
    const select = useJar ? jarSelect : byId("sampleClassSelect");
    let option = Array.from(select.options).find((item) => item.value === virtualPath);
    if (!option) {
      option = document.createElement("option");
      option.value = virtualPath;
      option.textContent = `${artifact.binaryName} (rebuilt)`;
      select.appendChild(option);
    }
    const source = useJar ? "file" : "sample";
    document.querySelector(`input[name="classSource"][value="${source}"]`).checked = true;
    window.setClassSource(source);
    select.value = virtualPath;
    workbenchState.suppressClassDocumentActivation = !activateDisassembly;
    try {
      await window.loadVirtualClass(virtualPath);
    } finally {
      workbenchState.suppressClassDocumentActivation = false;
    }
    if (activateDisassembly) activateWorkspace("disassemble");
    setToolStatus("compileStatus", `${artifact.binaryName} loaded into the JVM`, "success");
    return artifact;
  }

  async function compileAndRun() {
    setCompileActionsDisabled(true);
    try {
      const result = await compileSource({ manageButtons: false });
      if (!result || result.artifacts.length === 0) return;

      stageCompiledArtifacts();
      let runnable = null;
      for (let index = 0; index < result.artifacts.length; index += 1) {
        const artifact = result.artifacts[index];
        const classPath = `${artifact.internalName}.class`;
        const launchInfo = await window.jvmDebug.getClassLaunchInfo(classPath);
        if (launchInfo.launchMode) {
          runnable = { artifact, index, launchMode: launchInfo.launchMode };
          if (!artifact.internalName.includes("$")) break;
        }
      }
      if (!runnable) {
        setToolStatus(
          "compileStatus",
          "Compilation succeeded, but no main method or Applet entry point was emitted.",
          "error",
        );
        return;
      }

      const compiledClassSelect = byId("compiledClassSelect");
      compiledClassSelect.value = String(runnable.index);
      renderCompiledArtifact();
      await loadCompiledClass({ activateDisassembly: false });
      setRuntimeView(runnable.launchMode === "applet" ? "canvas" : "terminal");
      enterRunWorkspace();
      if (typeof window.runProgram !== "function") {
        throw new Error("The JVM Run action is not initialized");
      }
      await window.runProgram();
    } catch (error) {
      setToolStatus("compileStatus", error.message, "error");
    } finally {
      setCompileActionsDisabled(false);
    }
  }

  function downloadCompiledClass() {
    const artifact = selectedArtifact();
    if (!artifact) return;
    const blob = new Blob([artifact.bytes], { type: "application/java-vm" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${artifact.internalName.split("/").pop()}.class`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function focusRuntimeSurface() {
    const surface = byId("runtime-surface");
    if (surface.dataset.view === "terminal") {
      if (typeof window.focusJvmTerminal === "function") {
        window.focusJvmTerminal();
      }
      return;
    }
    const canvasContainer = byId("awt-container");
    const target = canvasContainer.querySelector("canvas") || canvasContainer;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function setRuntimeView(view, focus = false) {
    const surface = byId("runtime-surface");
    surface.dataset.view = view;
    document.querySelectorAll("[data-runtime-view]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.runtimeView === view));
    });
    if (view === "terminal" && typeof window.fitJvmTerminal === "function") {
      requestAnimationFrame(() => window.fitJvmTerminal());
    }
    if (focus) requestAnimationFrame(focusRuntimeSurface);
  }

  function enterRunWorkspace() {
    activateWorkspace("run");
    requestAnimationFrame(focusRuntimeSurface);
  }

  function enterDebuggerWorkspace() {
    activateWorkspace("debug");
  }

  function initialize() {
    initializeJavaEditors();
    workbenchState.javaSourceEditor.on("change", () => {
      const document = activeDocument();
      if (document && document.kind === "java") {
        markActiveDocumentChanged(workbenchState.javaSourceEditor.getValue());
      }
    });
    workbenchState.javaSourceEditor.commands.addCommand({
      name: "saveActiveJavaDocument",
      bindKey: { win: "Ctrl-S", mac: "Command-S" },
      exec: () => saveActiveDocument(),
    });
    document.querySelectorAll(".workspace-tab").forEach((tab, index, tabs) => {
      tab.addEventListener("click", () => selectWorkspaceView(tab.dataset.workspace));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        selectWorkspaceView(tabs[next].dataset.workspace, true);
      });
    });

    byId("assembleBtn").addEventListener("click", assembleEditedClass);
    byId("resetAssemblyBtn").addEventListener("click", resetAssemblyEdits);
    byId("compileBtn").addEventListener("click", () => compileSource());
    byId("compileRunBtn").addEventListener("click", compileAndRun);
    byId("compiledClassSelect").addEventListener("change", renderCompiledArtifact);
    byId("loadCompiledBtn").addEventListener("click", () => loadCompiledClass());
    byId("downloadCompiledBtn").addEventListener("click", downloadCompiledClass);
    byId("newJavaFileBtn").addEventListener("click", newJavaDocument);
    byId("newFolderBtn").addEventListener("click", showNewFolderDialog);
    byId("workspaceNewFolderBtn").addEventListener("click", showNewFolderDialog);
    byId("confirmNewFolderBtn").addEventListener("click", createWorkspaceFolder);
    byId("newFolderPath").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createWorkspaceFolder();
      }
    });
    byId("openFileMenuBtn").addEventListener("click", () => {
      workbenchState.openFromFileMenu = true;
      byId("fileMenu").open = false;
      byId("classFileInput").click();
    });
    byId("quickOpenBtn").addEventListener("click", () => {
      workbenchState.openFromFileMenu = true;
      byId("classFileInput").click();
    });
    byId("openSampleMenuBtn").addEventListener("click", () => {
      byId("fileMenu").open = false;
      byId("sampleCatalog").open = true;
      byId("sampleCatalog").querySelector("summary").focus();
    });
    byId("saveFileBtn").addEventListener("click", saveActiveDocument);
    byId("quickSaveBtn").addEventListener("click", saveActiveDocument);
    byId("saveAsFileBtn").addEventListener("click", showSaveAsDialog);
    byId("closeFileBtn").addEventListener("click", () => closeDocument());
    byId("saveAsName").addEventListener("input", updateSaveAsHint);
    byId("confirmSaveAsBtn").addEventListener("click", confirmSaveAs);
    document.querySelectorAll("[data-runtime-view]").forEach((button) => {
      button.addEventListener("click", () => {
        setRuntimeView(button.dataset.runtimeView, true);
      });
    });
    byId("runBtn").addEventListener("click", enterRunWorkspace);
    byId("debugBtn").addEventListener("click", enterDebuggerWorkspace);
    byId("classFileInput").addEventListener("change", async () => {
      const uploadSource = document.querySelector(
        'input[name="classSource"][value="file"]',
      );
      uploadSource.checked = true;
      setClassSource("file");
      const file = byId("classFileInput").files[0];
      setToolStatus(
        "assemblyStatus",
        file ? `${file.name} is ready to open.` : "Choose a Java, assembly, class, or JAR file.",
      );
      if (file && workbenchState.openFromFileMenu) {
        workbenchState.openFromFileMenu = false;
        try {
          await loadSelectedClass();
        } catch (error) {
          setToolStatus("assemblyStatus", error.message, "error");
        }
      }
    });
    document.querySelectorAll('input[name="classSource"]').forEach((input) => {
      input.addEventListener("change", () => setClassSource(input.value));
    });
    const selectedSource = document.querySelector(
      'input[name="classSource"]:checked');
    setClassSource(selectedSource ? selectedSource.value : "sample");

    window.addEventListener("javatools:class-loading", () => {
      captureActiveDocument();
    });

    window.addEventListener("javatools:assembly-editor-ready", () => {
      workbenchState.assemblyEditorBound = null;
      bindAssemblyEditor();
      const document = activeDocument();
      if (document && document.kind !== "java" && window.aceEditor) {
        workbenchState.ignoreEditorChanges = true;
        window.aceEditor.setValue(document.content, -1);
        window.aceEditor.clearSelection();
        workbenchState.ignoreEditorChanges = false;
        renderDocumentTabs();
      }
    });

    window.addEventListener("javatools:class-loaded", async (event) => {
      workbenchState.currentClassPath = event.detail.classPath;
      workbenchState.originalAssembly = event.detail.assemblyText ||
        window.jvmDebug.getClassDisassembly(event.detail.bytes);
      addAssemblyDocument(
        event.detail.classPath.replace(/\.class$/i, ".j"),
        workbenchState.originalAssembly,
        { backingClassPath: event.detail.classPath },
      );
      byId("assembleBtn").disabled = false;
      byId("resetAssemblyBtn").disabled = false;
      setToolStatus(
        "assemblyStatus",
        `${event.detail.classPath} · ${event.detail.bytes.length.toLocaleString()} bytes`,
        "success",
      );
      if (workbenchState.debugCodeEditor && window.jvmDebug) {
        const disassembly = window.jvmDebug.getClassDisassembly(event.detail.bytes);
        workbenchState.debugCodeEditor.setValue(disassembly, -1);
        workbenchState.debugCodeEditor.clearSelection();
        byId("debugCodeContext").textContent =
          `${event.detail.classPath} · ready`;
      }
      try {
        const launchInfo = await window.jvmDebug.getClassLaunchInfo(
          event.detail.classPath,
        );
        if (workbenchState.currentClassPath !== event.detail.classPath) return;
        workbenchState.launchMode = launchInfo.launchMode || "application";
        const isApplet = workbenchState.launchMode === "applet";
        setRuntimeView(isApplet ? "canvas" : "terminal");
        byId("runtimeModeHint").textContent = isApplet
          ? "Applet detected · AWT canvas selected automatically."
          : "Application detected · xterm selected automatically.";
      } catch (_) {
        workbenchState.launchMode = "application";
        setRuntimeView("terminal");
      }
    });

    addJavaDocument("/src/HelloWorkbench.java", DEFAULT_SOURCE);
    refreshWorkspaceTree();
    setCodeOutput("compiler-output", "",
      "Compile Java source to inspect generated JVM bytecode.");

    document.addEventListener("keydown", (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        newJavaDocument();
      } else if (key === "o") {
        event.preventDefault();
        workbenchState.openFromFileMenu = true;
        byId("classFileInput").click();
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        showSaveAsDialog();
      } else if (key === "s") {
        event.preventDefault();
        saveActiveDocument();
      } else if (key === "w") {
        event.preventDefault();
        closeDocument();
      }
    });
  }

  window.openJavaToolsWorkspace = activateWorkspace;
  window.setClassSource = setClassSource;
  window.loadSelectedClass = loadSelectedClass;
  window.javaToolsWorkspace = {
    listDocuments() {
      captureActiveDocument();
      return Array.from(workbenchState.documents.values(), (document) => ({
        id: document.id,
        kind: document.kind,
        path: document.path,
        backingClassPath: document.backingClassPath,
        dirty: document.dirty,
      }));
    },
    activeDocument() {
      captureActiveDocument();
      const document = activeDocument();
      return document ? {
        id: document.id,
        kind: document.kind,
        path: document.path,
        backingClassPath: document.backingClassPath,
        dirty: document.dirty,
      } : null;
    },
    save: saveActiveDocument,
    saveAs: showSaveAsDialog,
    createDirectory: async (folderPath) => {
      const workspace = await window.jvmDebug.ensureWorkspace();
      const normalized = normalizeWorkspacePath(folderPath);
      workspace.mkdirSync(normalized, { recursive: true });
      workbenchState.workspaceRoots.add(normalized.split("/").filter(Boolean)[0]);
      refreshWorkspaceTree();
      return normalized;
    },
    refreshFiles: refreshWorkspaceTree,
  };
  document.addEventListener("DOMContentLoaded", initialize);
})();
