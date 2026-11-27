// Local stand-in for the built-in Claude stream-json CLI. This fixture has no network or login code.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;

class FixtureClaude {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Process Self = Process.GetCurrentProcess();
    static string session;
    static Process worker;
    static bool timerOwnedByRuntime;
    static string State(string suffix) { return Path.Combine(Environment.CurrentDirectory, session + suffix); }
    static void Send(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Audit(string action) {
        File.AppendAllText(State(".audit"), Json.Serialize(new { action, pid = Self.Id, worker = worker == null ? 0 : worker.Id }) + "\n");
    }
    static void Reply(string text) {
        Send(new { type = "assistant", message = new { id = Guid.NewGuid().ToString(), role = "assistant", model = "fixture",
            content = new[] { new { type = "text", text } } } });
        Send(new { type = "result", subtype = "success", is_error = false, result = text, stop_reason = "end_turn", session_id = session });
    }
    static int Main(string[] args) {
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("2.1.231 (Claude Code fixture)"); return 0; }
        if (Array.IndexOf(args, "--fixture-worker") >= 0) { Thread.Sleep(90000); return 0; }
        int index = Array.IndexOf(args, "--session-id");
        bool resume = index < 0;
        if (resume) index = Array.IndexOf(args, "--resume");
        Guid known; if (index < 0 || index + 1 >= args.Length || !Guid.TryParse(args[index + 1], out known)) return 2;
        session = args[index + 1];
        if (resume && !File.Exists(State(".history"))) return 3;
        Audit(resume ? "resume" : "new");
        for (string line; (line = Console.ReadLine()) != null;) {
            var frame = Json.Deserialize<Dictionary<string, object>>(line);
            if ((string)frame["type"] == "control_request") {
                var request = (Dictionary<string, object>)frame["request"];
                if ((string)request["subtype"] == "interrupt" && worker != null) {
                    if (!timerOwnedByRuntime && !worker.HasExited) { worker.Kill(); worker.WaitForExit(5000); }
                    Audit("interrupt");
                    Send(new { type = "result", subtype = "error_during_execution", is_error = true, session_id = session });
                }
                Send(new { type = "control_response", response = new { subtype = "success", request_id = frame["request_id"], response = new { } } });
                continue;
            }
            if ((string)frame["type"] != "user") continue;
            Send(new { type = "system", subtype = "init", session_id = session, model = "fixture", tools = new string[0], mcp_servers = new string[0] });
            var match = System.Text.RegularExpressions.Regex.Match(line, @"W1_REMEMBER_([a-f0-9]{32})");
            if (match.Success) { File.WriteAllText(State(".history"), match.Groups[1].Value); Reply("stored"); }
            else if (line.Contains("W1_HOLD")) {
                // The direct restart case leaves this ordinary bounded timer to the host's Job.
                timerOwnedByRuntime = line.Contains("W1_HOLD_TIMER");
                worker = Process.Start(new ProcessStartInfo(Self.MainModule.FileName, "--fixture-worker") { UseShellExecute = false, CreateNoWindow = true });
                Audit("working");
            } else if (line.Contains("W1_RECALL")) Reply("recall-" + File.ReadAllText(State(".history")));
            else return 4;
        }
        return 0;
    }
}
