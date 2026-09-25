# career-ops dashboard launcher (script version)
# Lightweight alternative to career-dashboard-ui.exe
# 
# Usage:
#   powershell -File dashboard-ui/start-dashboard.ps1
#   # or double-click the .ps1 file

param(
    [string]$IconPath = "$PSScriptRoot\icon-256.png",
    [string]$RuntimeDir = "$PSScriptRoot\..\..\.dashboard-runtime"
)

Add-Type @"
using System;
using System.Net;
using System.Drawing;
using System.Windows.Forms;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Collections.Generic;

public class TrayApp {
    // ADR-0063: the web port is pinned to 3000 — never drifts to another port.
    private const int WebPort = 3000;
    private NotifyIcon _tray;
    private Process _serverProcess;
    private string _logFile;
    private StringBuilder _log = new StringBuilder();
    
    public TrayApp(string iconPath, string runtimeDir) {
        _logFile = Path.Combine(runtimeDir, "tray-debug.log");
        
        Icon icon = new Icon(iconPath);
        _tray = new NotifyIcon();
        _tray.Icon = icon;
        _tray.Visible = true;
        _tray.Text = "Career-Ops Dashboard";
        
        ContextMenuStrip menu = new ContextMenuStrip();
        
        // Open panel
        ToolStripMenuItem openItem = new ToolStripMenuItem("Open Panel");
        openItem.Click += new EventHandler(OnOpenPanel);
        menu.Items.Add(openItem);
        
        menu.Items.Add(new ToolStripSeparator());
        
        // Restart server
        ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart Server");
        restartItem.Click += new EventHandler(OnRestartServer);
        menu.Items.Add(restartItem);
        
        menu.Items.Add(new ToolStripSeparator());
        
        // Quit
        ToolStripMenuItem quitItem = new ToolStripMenuItem("Quit");
        quitItem.Click += new EventHandler(OnQuit);
        menu.Items.Add(quitItem);
        
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += new EventHandler(OnDoubleClick);
        
        Log("tray log started: pid=" + Process.GetCurrentProcess().Id);
        Log("tray: onReady completed");
    }
    
    private void OnOpenPanel(object sender, EventArgs e) {
        OpenBrowser();
    }
    
    private void OnRestartServer(object sender, EventArgs e) {
        RestartServer();
    }
    
    private void OnQuit(object sender, EventArgs e) {
        Quit();
    }
    
    private void OnDoubleClick(object sender, EventArgs e) {
        OpenBrowser();
    }
    
    private void Log(string msg) {
        string line = DateTime.Now.ToString("yyyy/MM/dd HH:mm:ss") + " " + msg;
        _log.AppendLine(line);
        try {
            string dir = Path.GetDirectoryName(_logFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.AppendAllText(_logFile, line + "\n");
        } catch {}
    }
    
    // ADR-0063 probe: does a live server already answer on the pinned port?
    private bool ProbeAlive() {
        try {
            // Access URL uses "localhost" per the house rule; .NET falls back to 127.0.0.1 when ::1 is unanswered.
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://localhost:" + WebPort + "/api/version");
            request.Timeout = 1500;
            using (WebResponse response = request.GetResponse()) {
                return ((HttpWebResponse)response).StatusCode == HttpStatusCode.OK;
            }
        } catch {
            return false;
        }
    }

    // ADR-0063: find whatever LISTENs on the pinned port and force-kill it with
    // its process tree (taskkill /T /F). Targets any process, not only node —
    // mirrors start-web.cmd. Returns false if an owner was found but couldn't be
    // killed within the timeout, so the caller errors out instead of drifting.
    private bool KillPortOwner(int waitMs) {
        string pids;
        try {
            Process ps = new Process();
            ps.StartInfo.FileName = "powershell";
            ps.StartInfo.Arguments = "-NoProfile -Command \"(Get-NetTCPConnection -LocalPort " + WebPort + " -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ' '\"";
            ps.StartInfo.UseShellExecute = false;
            ps.StartInfo.RedirectStandardOutput = true;
            ps.StartInfo.CreateNoWindow = true;
            ps.Start();
            pids = ps.StandardOutput.ReadToEnd().Trim();
            ps.WaitForExit();
        } catch (Exception ex) {
            Log("owner lookup failed: " + ex.Message);
            return true; // could not resolve an owner; let the bind attempt decide
        }

        if (string.IsNullOrEmpty(pids)) return true; // port is free

        foreach (string s in pids.Split(' ')) {
            int pid;
            if (!int.TryParse(s, out pid) || pid <= 0) continue;
            Log("killing port owner pid=" + pid + " (tree)");
            try {
                Process tk = new Process();
                tk.StartInfo.FileName = "taskkill";
                tk.StartInfo.Arguments = "/PID " + pid + " /T /F";
                tk.StartInfo.UseShellExecute = false;
                tk.StartInfo.CreateNoWindow = true;
                tk.Start();
                tk.WaitForExit();
            } catch (Exception ex) {
                Log("taskkill pid=" + pid + " failed: " + ex.Message);
            }
        }

        // Wait for the port to actually free up.
        int waited = 0;
        while (waited < waitMs) {
            if (!PortInUse()) return true;
            Thread.Sleep(250);
            waited += 250;
        }
        return !PortInUse();
    }

    private bool PortInUse() {
        try {
            var props = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties();
            foreach (var ep in props.GetActiveTcpListeners()) {
                if (ep.Port == WebPort) return true;
            }
        } catch {}
        return false;
    }
    
    private void StartServer() {
        StopServer();

        // ADR-0063: reuse a live instance (standalone OR dev) on the pinned port;
        // never start a second server, never drift to another port.
        if (ProbeAlive()) {
            Log("port " + WebPort + " already serves a live web — reusing it");
            OpenBrowser();
            return;
        }

        int port = WebPort;
        
        // Find career-ops root by scanning from script location
        string scriptPath = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string scriptDir = Path.GetDirectoryName(scriptPath);
        if (string.IsNullOrEmpty(scriptDir)) scriptDir = Environment.CurrentDirectory;
        
        string[] candidates = new string[] {
            Path.GetFullPath(Path.Combine(scriptDir, "..", "..")),
            Path.GetFullPath(Path.Combine(scriptDir, "..")),
            Path.GetFullPath(scriptDir)
        };
        
        string careerOpsRoot = "";
        foreach (string c in candidates) {
            if (Directory.Exists(Path.Combine(c, "web", ".next", "standalone"))) {
                careerOpsRoot = c;
                break;
            }
        }
        if (string.IsNullOrEmpty(careerOpsRoot)) careerOpsRoot = candidates[0];
        
        string serverJs = Path.Combine(careerOpsRoot, "web", ".next", "standalone", "server.js");
        string standaloneDir = Path.Combine(careerOpsRoot, "web", ".next", "standalone");
        
        if (!File.Exists(serverJs)) {
            Log("ERROR: server.js not found at " + serverJs);
            MessageBox.Show("Dashboard server not found. Run 'npm run build:dashboard' first.", 
                "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        
        // ADR-0063: evict whatever owns the pinned port (any process, tree) before
        // binding. If it can't be freed, error out — do NOT fall back to another port.
        if (!KillPortOwner(10000)) {
            Log("ERROR: port " + WebPort + " could not be freed");
            MessageBox.Show("Cannot start dashboard: port 3000 is occupied and could not be freed.\n\nEnd the occupying process and retry (the port is pinned to 3000 and will not fall back to another).",
                "career-ops dashboard", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        
        // Start Node
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "node";
        psi.Arguments = "\"" + serverJs + "\"";
        psi.WorkingDirectory = standaloneDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["CAREER_OPS_ROOT"] = careerOpsRoot;
        psi.EnvironmentVariables["PORT"] = port.ToString();
        psi.EnvironmentVariables["HOSTNAME"] = "127.0.0.1";  // bind address only - always an explicit IPv4 literal, never "localhost" (Windows resolves localhost to ::1 first and the standalone server would bind the IPv6 loopback only)
        psi.EnvironmentVariables["NODE_ENV"] = "production";
        
        _serverProcess = new Process();
        _serverProcess.StartInfo = psi;
        _serverProcess.OutputDataReceived += new DataReceivedEventHandler(OnOutputData);
        _serverProcess.ErrorDataReceived += new DataReceivedEventHandler(OnErrorData);
        _serverProcess.Exited += new EventHandler(OnServerExited);
        _serverProcess.Start();
        _serverProcess.BeginOutputReadLine();
        _serverProcess.BeginErrorReadLine();
        
        Log("server started: port=" + port + " pid=" + _serverProcess.Id + " root=" + careerOpsRoot);
        
        WaitForServerReady(port);
        OpenBrowser();
    }
    
    private void OnOutputData(object sender, DataReceivedEventArgs e) {
        if (e.Data != null) Log("out: " + e.Data);
    }
    
    private void OnErrorData(object sender, DataReceivedEventArgs e) {
        if (e.Data != null) Log("err: " + e.Data);
    }
    
    private void OnServerExited(object sender, EventArgs e) {
        Log("server exited unexpectedly pid=" + _serverProcess.Id);
    }
    
    private void WaitForServerReady(int port, int maxAttempts = 30) {
        for (int i = 0; i < maxAttempts; i++) {
            Thread.Sleep(500);
            try {
                // Access URL uses "localhost" per the house rule; .NET falls back to 127.0.0.1 when ::1 is unanswered.
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/api/version");
                request.Timeout = 1000;
                WebResponse response = request.GetResponse();
                HttpWebResponse hr = (HttpWebResponse)response;
                if (hr.StatusCode == HttpStatusCode.OK) {
                    Log("server ready: port=" + port);
                    return;
                }
            } catch {}
        }
        Log("WARNING: server may not be ready yet");
    }
    
    private void StopServer() {
        if (_serverProcess != null && !_serverProcess.HasExited) {
            try { _serverProcess.Kill(); } catch {}
            _serverProcess = null;
        }
    }
    
    private void RestartServer() {
        Log("restart requested");
        StopServer();
        // StartServer re-runs the full ADR-0063 takeover chain on the pinned port.
        StartServer();
    }
    
    private void OpenBrowser() {
        string url = "http://localhost:" + WebPort;
        try {
            Process.Start("cmd", "/c start \"\" \"" + url + "\"");
            Log("browser opened: " + url);
        } catch (Exception ex) {
            Log("browser open failed: " + ex.Message);
        }
    }
    
    private void Quit() {
        Log("quit requested");
        StopServer();
        _tray.Visible = false;
        _tray.Dispose();
        Environment.Exit(0);
    }
    
    public void Run() {
        StartServer();
        Application.Run();
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

# Ensure runtime dir exists
$runtimeDir = $PSScriptRoot.Replace("\dashboard-ui\", "\.dashboard-runtime")
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

# Run the tray app
$app = New-Object TrayApp $IconPath, $runtimeDir
$app.Run()
