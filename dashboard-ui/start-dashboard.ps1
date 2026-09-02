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
using System.Drawing;
using System.Windows.Forms;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Collections.Generic;

public class TrayApp {
    private NotifyIcon _tray;
    private bool _running;
    private int _port;
    private Process _serverProcess;
    private string _lockFile;
    private string _logFile;
    private StringBuilder _log = new StringBuilder();
    
    public TrayApp(string iconPath, string runtimeDir) {
        _port = 0;
        _running = false;
        _lockFile = Path.Combine(runtimeDir, "LOCK");
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
    
    private int PickFreePort() {
        System.Net.Sockets.TcpListener tcp = new System.Net.Sockets.TcpListener(
            System.Net.IPAddress.Loopback, 0);
        tcp.Start();
        int port = ((System.Net.IPEndPoint)tcp.LocalEndpoint).Port;
        tcp.Stop();
        return port;
    }
    
    private int ReadPortFromLock() {
        try {
            if (File.Exists(_lockFile)) {
                string line = File.ReadAllText(_lockFile).Trim();
                int p = 0;
                if (int.TryParse(line, out p) && p > 0) return p;
            }
        } catch {}
        return 0;
    }
    
    private void KillServerForPort(int port) {
        try {
            var props = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties();
            var connections = props.GetActiveTcpConnections();
            var targetPids = new HashSet<int>();
            foreach (var conn in connections) {
                if (conn.LocalEndPoint.Port == port) {
                    int stateInt = (int)conn.State;
                    // Established = 1 in TcpState enum
                    if (stateInt == 1) {
                        try {
                            var proc = Process.GetProcessById(conn.OwningProcessId);
                            if (proc.ProcessName == "node") {
                                Log("killing existing node pid=" + conn.OwningProcessId + " on port " + port);
                                proc.Kill();
                            }
                        } catch {}
                    }
                }
            }
        } catch {}
    }
    
    private void StartServer() {
        StopServer();
        
        int port = ReadPortFromLock();
        if (port == 0) port = PickFreePort();
        
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
        
        // Kill any existing server on this port
        KillServerForPort(port);
        
        // Write lock file
        try {
            string lockDir = Path.GetDirectoryName(_lockFile);
            if (!string.IsNullOrEmpty(lockDir)) Directory.CreateDirectory(lockDir);
            File.WriteAllText(_lockFile, port.ToString());
        } catch {}
        
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
        psi.EnvironmentVariables["HOSTNAME"] = "127.0.0.1";
        psi.EnvironmentVariables["NODE_ENV"] = "production";
        
        _serverProcess = new Process();
        _serverProcess.StartInfo = psi;
        _serverProcess.OutputDataReceived += new DataReceivedEventHandler(OnOutputData);
        _serverProcess.ErrorDataReceived += new DataReceivedEventHandler(OnErrorData);
        _serverProcess.Exited += new EventHandler(OnServerExited);
        _serverProcess.Start();
        _serverProcess.BeginOutputReadLine();
        _serverProcess.BeginErrorReadLine();
        
        _port = port;
        _running = true;
        
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
        _running = false;
    }
    
    private void WaitForServerReady(int port, int maxAttempts = 30) {
        for (int i = 0; i < maxAttempts; i++) {
            Thread.Sleep(500);
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/version");
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
        _running = false;
    }
    
    private void RestartServer() {
        Log("restart requested");
        StopServer();
        try { File.Delete(_lockFile); } catch {}
        StartServer();
    }
    
    private void OpenBrowser() {
        int port = ReadPortFromLock();
        if (port == 0) port = _port;
        if (port == 0) port = 3000;
        
        string url = "http://localhost:" + port;
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
        try { File.Delete(_lockFile); } catch {}
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
