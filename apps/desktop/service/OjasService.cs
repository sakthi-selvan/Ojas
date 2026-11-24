// Ojas Server Windows Service host.
//
// Runs the Ojas server (resources\server\main.js) with Ojas.exe in Node mode, so the clinic's
// server PC keeps serving every desk even when nobody is signed in to Windows. Restarts the server
// if it crashes, stops it cleanly ("shutdown" on stdin) so the database flushes, and logs its output.
//
//   OjasService.exe install     register + start the service, open the firewall (run elevated)
//   OjasService.exe uninstall   stop + remove the service and firewall rules (data is kept)
//   OjasService.exe run         run in this console (for testing), Enter stops
//   (no arguments)              started by the Windows Service Control Manager
//
// Built with the C# compiler that ships with Windows (.NET Framework 4), see scripts/build-service.mjs.
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

public class OjasService : ServiceBase
{
    public const string Name = "OjasServer";
    const int Port = 4870;
    const int DiscoveryPort = 4872;
    const string RuleHttps = "Ojas Server (HTTPS)";
    const string RuleDiscovery = "Ojas Server (discovery)";

    static string Here { get { return AppDomain.CurrentDomain.BaseDirectory; } }
    static string Resources { get { return Path.GetFullPath(Path.Combine(Here, "..")); } }
    static string OjasExe { get { return Path.GetFullPath(Path.Combine(Resources, "..", "Ojas.exe")); } }
    /** %ProgramData%\Ojas, or OJAS_HOME when testing ("run" mode) without touching a real install. */
    static string ProgramData
    {
        get
        {
            string home = Environment.GetEnvironmentVariable("OJAS_HOME");
            return string.IsNullOrEmpty(home) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Ojas") : home;
        }
    }
    /** Patient data, backups and logs: SYSTEM and Administrators only. */
    static string DataDir { get { return Path.Combine(ProgramData, "data"); } }
    /** The certificate (public part) must stay readable, so the desktop app on this PC can pin it. */
    static string TlsDir { get { return Path.Combine(ProgramData, "tls"); } }
    static string LogFile { get { return Path.Combine(DataDir, "logs", "server.log"); } }

    Process child;
    Thread supervisor;
    /** Console mode runs as the signed-in user, who can't read a key locked to SYSTEM. */
    bool consoleMode;
    volatile bool stopping;
    static readonly object logLock = new object();

    public OjasService()
    {
        ServiceName = Name;
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    public static int Main(string[] args)
    {
        string verb = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        try
        {
            if (verb == "install") return Install();
            if (verb == "uninstall") return Uninstall();
            if (verb == "run")
            {
                var s = new OjasService();
                s.consoleMode = true;
                s.Begin();
                Console.WriteLine("Ojas server running (log: " + LogFile + "). Press Enter to stop.");
                Console.ReadLine();
                s.End();
                return 0;
            }
            if (verb != "") { Console.Error.WriteLine("Usage: OjasService.exe [install|uninstall|run]"); return 2; }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
        ServiceBase.Run(new OjasService());
        return 0;
    }

    protected override void OnStart(string[] args) { Begin(); }
    protected override void OnStop() { End(); }
    protected override void OnShutdown() { End(); }

    void Begin()
    {
        stopping = false;
        supervisor = new Thread(Supervise);
        supervisor.IsBackground = true;
        supervisor.Start();
    }

    void End()
    {
        stopping = true;
        RequestAdditionalTimeSafe(25000);
        Process c = child;
        if (c == null) return;
        try
        {
            if (!c.HasExited)
            {
                c.StandardInput.WriteLine("shutdown");
                c.StandardInput.Flush();
                if (!c.WaitForExit(20000)) { Log("Server didn't stop in 20 s; ending it"); c.Kill(); }
            }
        }
        catch (Exception e) { Log("Stop: " + e.Message); }
        Log("Service stopped");
    }

    void RequestAdditionalTimeSafe(int ms)
    {
        try { RequestAdditionalTime(ms); } catch { /* not running under the SCM (console mode) */ }
    }

    /** Keeps the server running; backs off when it keeps crashing so the log stays readable. */
    void Supervise()
    {
        int failures = 0;
        while (!stopping)
        {
            DateTime started = DateTime.UtcNow;
            try
            {
                StartChild();
                child.WaitForExit();
            }
            catch (Exception e)
            {
                Log("Could not start the server: " + e.Message);
            }
            if (stopping) break;
            if ((DateTime.UtcNow - started).TotalMinutes > 5) failures = 0;
            failures++;
            int wait = Math.Min(60000, 2000 * failures);
            Log("Server exited (code " + SafeExitCode() + "); restarting in " + (wait / 1000) + " s");
            Thread.Sleep(wait);
        }
    }

    string SafeExitCode()
    {
        try { return child.ExitCode.ToString(); } catch { return "?"; }
    }

    void StartChild()
    {
        var psi = new ProcessStartInfo(OjasExe, Quote(Path.Combine(Resources, "server", "main.js")));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = Path.Combine(Resources, "server");
        var env = psi.EnvironmentVariables;
        env["ELECTRON_RUN_AS_NODE"] = "1";
        env["OJAS_MODE"] = "server";
        env["OJAS_HOST"] = "0.0.0.0";
        env["OJAS_PORT"] = Port.ToString();
        env["OJAS_TLS"] = "1";
        env["OJAS_TLS_DIR"] = TlsDir;
        env["OJAS_DISCOVERY"] = "1";
        env["OJAS_STDIN_CONTROL"] = "1";
        env["OJAS_DATA_DIR"] = Path.Combine(DataDir, "db");
        env["OJAS_WEB_DIR"] = Path.Combine(Resources, "web");
        if (consoleMode) env["OJAS_RESTRICT_KEY"] = "0";

        var p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        p.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        Directory.CreateDirectory(Path.Combine(DataDir, "db"));
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        child = p;
        Log("Server started (pid " + p.Id + ")");
    }

    static void Log(string line)
    {
        lock (logLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                var fi = new FileInfo(LogFile);
                if (fi.Exists && fi.Length > 10 * 1024 * 1024)
                {
                    string old = LogFile + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(LogFile, old);
                }
                File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* logging must never stop the server */ }
        }
    }

    // ───────────────────────── install / uninstall ─────────────────────────

    static int Install()
    {
        if (!File.Exists(OjasExe)) throw new Exception("Ojas.exe not found at " + OjasExe);
        string me = Process.GetCurrentProcess().MainModule.FileName;
        string bin = "\"\\\"" + me + "\\\"\"";
        if (Run("sc.exe", "query " + Name, true) == 0)
        {
            Run("sc.exe", "stop " + Name, true);
            WaitForStatus("STOPPED", 30);
            Must(Run("sc.exe", "config " + Name + " binPath= " + bin + " start= delayed-auto", false), "configure the service");
        }
        else
        {
            Must(Run("sc.exe", "create " + Name + " binPath= " + bin + " start= delayed-auto DisplayName= \"Ojas Server\"", false), "create the service");
        }
        Run("sc.exe", "description " + Name + " \"Ojas clinic server: the database and screens for every desk on the clinic network.\"", true);
        // Restart automatically after a crash: 5 s, 10 s, then every minute.
        Run("sc.exe", "failure " + Name + " reset= 86400 actions= restart/5000/restart/10000/restart/60000", true);

        // Desks on the clinic network (private/domain networks only, never public Wi-Fi profiles).
        Run("netsh.exe", "advfirewall firewall delete rule name=\"" + RuleHttps + "\"", true);
        Run("netsh.exe", "advfirewall firewall delete rule name=\"" + RuleDiscovery + "\"", true);
        Must(Run("netsh.exe", "advfirewall firewall add rule name=\"" + RuleHttps + "\" dir=in action=allow protocol=TCP localport=" + Port + " profile=private,domain", false), "open the firewall");
        Must(Run("netsh.exe", "advfirewall firewall add rule name=\"" + RuleDiscovery + "\" dir=in action=allow protocol=UDP localport=" + DiscoveryPort + " profile=private,domain", false), "open the firewall");

        // Patient data, backups and logs: only SYSTEM (the service) and Administrators.
        Directory.CreateDirectory(DataDir);
        Must(Run("icacls.exe", Quote(DataDir) + " /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F", false), "protect the data folder");
        Directory.CreateDirectory(TlsDir);

        Must(Run("sc.exe", "start " + Name, false), "start the service");
        Console.WriteLine("Ojas Server installed and started.");
        return 0;
    }

    static int Uninstall()
    {
        if (Run("sc.exe", "query " + Name, true) == 0)
        {
            Run("sc.exe", "stop " + Name, true);
            WaitForStatus("STOPPED", 30);
            Run("sc.exe", "delete " + Name, true);
        }
        Run("netsh.exe", "advfirewall firewall delete rule name=\"" + RuleHttps + "\"", true);
        Run("netsh.exe", "advfirewall firewall delete rule name=\"" + RuleDiscovery + "\"", true);
        Console.WriteLine("Ojas Server removed. Data in " + DataDir + " was kept.");
        return 0;
    }

    static void WaitForStatus(string status, int seconds)
    {
        for (int i = 0; i < seconds * 2; i++)
        {
            var o = new StringBuilder();
            Run("sc.exe", "query " + Name, true, o);
            if (o.ToString().Contains(status)) return;
            Thread.Sleep(500);
        }
    }

    static void Must(int code, string what)
    {
        if (code != 0) throw new Exception("Couldn't " + what + " (exit code " + code + ")");
    }

    static int Run(string exe, string args, bool quiet, StringBuilder output = null)
    {
        var psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        using (var p = Process.Start(psi))
        {
            string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit();
            if (output != null) output.Append(o);
            if (!quiet && p.ExitCode != 0) Console.Error.WriteLine(exe + " " + args + "\n" + o.Trim());
            return p.ExitCode;
        }
    }

    static string Quote(string s) { return "\"" + s + "\""; }
}
