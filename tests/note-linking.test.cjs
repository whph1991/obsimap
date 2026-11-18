const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

// Exercise the real view without launching Obsidian. Only host UI/storage APIs
// are replaced; linking, history, serialization, and save dispatch stay real.
const root = path.resolve(__dirname, "..");
const compiled = buildSync({
    stdin: {
        contents: readFileSync(path.join(root, "src/core/main.ts"), "utf8")
            + "\nexport { MindMapView };\n",
        resolveDir: path.join(root, "src/core"),
        loader: "ts",
    },
    bundle: true,
    external: ["obsidian"],
    format: "cjs",
    write: false,
}).outputFiles[0].text;

function svgElement(tag) {
    return {
        tag, children: [], attributes: {}, textContent: "",
        classList: { add() {} },
        setAttribute(name, value) { this.attributes[name] = value; },
        appendChild(child) { this.children.push(child); },
    };
}

function fixture(chosenPath = "Projects/Target.md") {
    class TFile {
        constructor(filePath) {
            this.path = filePath;
            this.basename = path.posix.basename(filePath, ".md");
            this.extension = "md";
        }
    }
    const chosen = new TFile(chosenPath);
    const other = new TFile("Target.md");
    const opened = [];
    const notices = [];
    const saved = [];
    const host = {
        Plugin: class {}, PluginSettingTab: class {}, Modal: class {},
        TextFileView: class {}, TFile,
        FuzzySuggestModal: class {
            open() { this.onChooseItem(chosen, {}); }
        },
        Notice: class { constructor(message) { notices.push(message); } },
    };
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
        module, exports: module.exports,
        require(name) {
            assert.equal(name, "obsidian");
            return host;
        },
        HTMLElement: class {},
        document: { createElementNS: (_namespace, tag) => svgElement(tag) },
    });
    const view = Object.create(module.exports.MindMapView.prototype);
    Object.assign(view, {
        file: { path: "Maps/Example.mindmap" },
        selectedNodeId: "root",
        mindMapData: { root: { id: "root", text: "Original", children: [] } },
        historyStack: [],
        selectedNodeIds: new Set(),
        settings: { maxNodeLength: 30, nodeStyle: "pill", layoutMode: "outline", showHoverPreview: true },
        g: svgElement("g"),
        domEvents: [],
        registerDomEvent(element, event, handler) { this.domEvents.push({ element, event, handler }); },
        containerEl: { querySelector: () => null },
        render() {},
        // TextFileView owns disk I/O. Capture the actual serialized state at
        // the point where the plugin requests that host to save it.
        requestSave() { saved.push(this.getViewData()); },
        app: {
            metadataCache: {
                getFirstLinkpathDest(link) {
                    if (link === "Target") return other;
                    if (link === chosen.path.replace(/\.md$/, "")) return chosen;
                    return null;
                },
            },
            workspace: {
                getLeaf: () => ({ openFile: async file => opened.push(file.path) }),
            },
        },
    });
    return { view, opened, notices, saved };
}

test("search link opens the chosen file even when a root note has the same name", async () => {
    const { view, opened, notices } = fixture();
    view.openNoteSearch();
    await view.openLinkedNote();
    assert.deepEqual(opened, ["Projects/Target.md"]);
    assert.deepEqual(notices, []);
});

test("search link requests persistence of the updated map immediately", () => {
    const { view, saved } = fixture();
    view.openNoteSearch();
    assert.equal(saved.length, 1);
    const data = JSON.parse(saved[0].match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.equal(data.root.text, "[[Projects/Target|Target]]");
});

test("undo restores and saves the text from before linking", () => {
    const { view, saved } = fixture();
    view.openNoteSearch();
    view.undo();
    assert.equal(view.mindMapData.root.text, "Original");
    assert.equal(saved.length, 2);
    assert.match(saved[1], /"text": "Original"/);
});

test("search link still opens a root-level note", async () => {
    const { view, opened } = fixture("Root note.md");
    view.openNoteSearch();
    await view.openLinkedNote();
    assert.deepEqual(opened, ["Root note.md"]);
});

test("search without a selected node leaves the map unchanged", () => {
    const { view, saved } = fixture();
    view.selectedNodeId = null;
    view.openNoteSearch();
    assert.equal(view.mindMapData.root.text, "Original");
    assert.equal(saved.length, 0);
});

for (const [stored, displayed] of [
    ["[[Projects/Target|Weekly meeting]]", "Weekly meeting"],
    ["[[Projects/Target]]", "Target"],
    ["[[Projects/Target.md]]", "Target"],
    ["[[Target]]", "Target"],
    ["Discuss [[Projects/Target|meeting]] today", "Discuss meeting today"],
    ["[[A/One]] and [[B/Two|Second]]", "One and Second"],
    ["Ordinary text", "Ordinary text"],
]) {
    test(`renders a readable label for ${stored}`, () => {
        const { view } = fixture();
        const node = view.mindMapData.root;
        node.text = stored;
        view.renderNode(node);
        const rendered = view.g.children[0];
        const label = rendered.children.find(child => child.tag === "text");
        assert.equal(label.textContent, displayed);
        assert.equal(node.text, stored, "rendering must not change the stored link");
        assert.equal(view.getNodeWidth(stored), view.getNodeWidth(displayed));
    });
}

test("long paths with short labels do not truncate or enable hover previews", () => {
    const { view } = fixture();
    view.mindMapData.root.text = "[[Very/Long/Folder/Hierarchy/Projects/Target|Short]]";
    view.renderNode(view.mindMapData.root);
    const rendered = view.g.children[0];
    assert.equal(rendered.children.find(child => child.tag === "text").textContent, "Short");
    assert.equal(rendered.children.find(child => child.tag === "rect").attributes.width, "120");
    assert.equal(view.domEvents.some(({ event }) => event === "mouseenter"), false);
});

test("long aliases are truncated by label length rather than link length", () => {
    const { view } = fixture();
    view.settings.maxNodeLength = 8;
    view.mindMapData.root.text = "[[Projects/Target|Weekly meeting]]";
    view.renderNode(view.mindMapData.root);
    const rendered = view.g.children[0];
    assert.equal(rendered.children.find(child => child.tag === "text").textContent, "Weekly m...");
    assert.equal(view.domEvents.some(({ event }) => event === "mouseenter"), true);
});

test("custom labels do not change the file opened", async () => {
    const { view, opened } = fixture();
    view.mindMapData.root.text = "[[Projects/Target|Custom label]]";
    await view.openLinkedNote();
    assert.deepEqual(opened, ["Projects/Target.md"]);
});
