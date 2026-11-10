import UIKit
import WebKit

enum AppConfig {
    /// The live Hangry site. The app is a shell around it and ships no web code of its own.
    static let home = URL(string: "https://hangry.up.railway.app/")!
}

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let offlineView = UIView()

    /// Runs before the page's own scripts. The web app nags to be added to the
    /// Home Screen and to enable Web Push; neither applies inside this shell.
    private static let bootScript = """
    (function () {
      try {
        Object.defineProperty(navigator, "standalone", { get: function () { return true; } });
      } catch (e) {}
      try {
        localStorage.setItem("fn_installed", "1");
        localStorage.setItem("fn_install_later", String(Date.now()));
      } catch (e) {}
    })();
    """

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "Mobile/15E148 HangryApp/1.0"
        config.userContentController.addUserScript(
            WKUserScript(source: Self.bootScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        // The page handles the notch and home indicator itself (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        view.addSubview(webView)

        buildOfflineView()
        loadHome()
    }

    private func loadHome() {
        offlineView.isHidden = true
        webView.load(URLRequest(url: AppConfig.home))
    }

    @objc private func retryTapped() {
        loadHome()
    }

    private func buildOfflineView() {
        offlineView.frame = view.bounds
        offlineView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        offlineView.backgroundColor = .black
        offlineView.isHidden = true

        let label = UILabel()
        label.text = "Can't reach Hangry.\nCheck your connection and try again."
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)

        let button = UIButton(type: .system)
        button.setTitle("Try again", for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.tintColor = UIColor(red: 1.0, green: 0.27, blue: 0.56, alpha: 1.0)
        button.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [label, button])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        offlineView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: offlineView.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: offlineView.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: offlineView.trailingAnchor, constant: -32),
        ])
        view.addSubview(offlineView)
    }

    private func isInternal(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return false }
        return url.host?.lowercased() == AppConfig.home.host?.lowercased()
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        // A missing target frame is a new-window request (target="_blank").
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if !mainFrame || isInternal(url) { return .allow }
        // Maps, mailto:, and every other site open outside the shell.
        _ = await UIApplication.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offlineView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        // Cancelled loads and links handed to another app are not connection failures.
        guard failure.domain == NSURLErrorDomain, failure.code != NSURLErrorCancelled else { return }
        offlineView.isHidden = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS killed the page while the app was in the background.
        if webView.url == nil {
            loadHome()
        } else {
            webView.reload()
        }
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // Internal links that ask for a new window stay in this one.
        if let url = navigationAction.request.url, isInternal(url) {
            webView.load(navigationAction.request)
        }
        return nil
    }

    // Without these, window.alert / confirm / prompt do nothing in a WKWebView.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        guard presentedViewController == nil else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume() })
            present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        guard presentedViewController == nil else { return false }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            present(alert, animated: true)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo
    ) async -> String? {
        guard presentedViewController == nil else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { field in field.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            present(alert, animated: true)
        }
    }
}
