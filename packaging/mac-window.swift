// CapCut Desk Mac window: starts the bundled server (Resources/CapCut Desk) and shows its page in an app window.
// Links that open a new tab (the CapCut sign-in page) go to the default browser; its callback lands on the local server.
import Cocoa
import WebKit

let url = URL(string: "http://127.0.0.1:38917/")!

class App: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
  var window: NSWindow!, web: WKWebView!, server: Process?

  func applicationDidFinishLaunching(_ n: Notification) {
    let p = Process()
    p.executableURL = Bundle.main.resourceURL!.appendingPathComponent("CapCut Desk")
    p.environment = ProcessInfo.processInfo.environment.merging(["NO_BROWSER": "1"]) { $1 }
    try? p.run(); server = p   // if a copy is already running the child exits and we show that copy

    web = WKWebView(frame: .zero); web.uiDelegate = self; web.navigationDelegate = self
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "CapCut Desk"; window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = NSColor(red: 0.075, green: 0.071, blue: 0.067, alpha: 1); window.minSize = NSSize(width: 640, height: 520); window.contentView = web; window.center(); window.setFrameAutosaveName("main")
    window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    load(tries: 40)
  }
  func load(tries: Int) {   // wait for the server to answer, then show the page
    var r = URLRequest(url: url); r.timeoutInterval = 1
    URLSession.shared.dataTask(with: r) { _, resp, _ in DispatchQueue.main.async {
      if resp != nil { self.web.load(URLRequest(url: url)) }
      else if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.load(tries: tries - 1) } }
      else { self.web.loadHTMLString("<h2 style='font:20px -apple-system;margin:40px'>CapCut Desk could not start. Quit and open it again.</h2>", baseURL: nil) }
    } }.resume()
  }
  // target=_blank links -> default browser
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { NSWorkspace.shared.open(u) }; return nil
  }
  // anything that is not the local page also goes to the browser
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = a.request.url, let h = u.host, h != "127.0.0.1", a.targetFrame?.isMainFrame == true { NSWorkspace.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
  }
  // file picker for reference uploads
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let o = NSOpenPanel(); o.allowsMultipleSelection = p.allowsMultipleSelection
    o.begin { completionHandler($0 == .OK ? o.urls : nil) }
  }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel"); completionHandler(a.runModal() == .alertFirstButtonReturn)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ n: Notification) { if server?.isRunning == true { server?.terminate() } }
}

let app = NSApplication.shared, d = App()
app.delegate = d; app.setActivationPolicy(.regular)
let bar = NSMenu(), appItem = NSMenuItem(), editItem = NSMenuItem(); bar.addItem(appItem); bar.addItem(editItem)
let appMenu = NSMenu(); appMenu.addItem(withTitle: "Quit CapCut Desk", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
let edit = NSMenu(title: "Edit")   // needed for copy/paste shortcuts
edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = edit; app.mainMenu = bar
app.run()
