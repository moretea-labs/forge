using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

public class ForgeComputerWslRelay {
  public static int Main(string[] args) {
    var wsl = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "wsl.exe");
    var process = new Process();
    process.StartInfo.FileName = wsl;
    process.StartInfo.Arguments = "-d UbuntuDev -e /usr/local/bin/node /home/greyson/.forge/controller/computer/chatgpt-native-host.mjs";
    process.StartInfo.CreateNoWindow = true;
    process.StartInfo.UseShellExecute = false;
    process.StartInfo.RedirectStandardInput = true;
    process.StartInfo.RedirectStandardOutput = true;
    process.StartInfo.RedirectStandardError = true;
    try {
      process.Start();
      var input = Task.Run(() => {
        try { Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream); }
        catch (IOException) {}
        finally { try { process.StandardInput.Close(); } catch {} }
      });
      var output = Task.Run(() => {
        try { process.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); }
        catch (IOException) {}
      });
      var errors = Task.Run(() => {
        try {
          var buffer = new byte[1024];
          while (process.StandardError.BaseStream.Read(buffer, 0, buffer.Length) > 0) { }
        } catch (IOException) {}
      });
      Task.WaitAll(input, output);
      process.WaitForExit();
      errors.Wait(1000);
      return process.ExitCode;
    } catch (Exception error) {
      Console.Error.WriteLine("FORGE_COMPUTER_WSL_RELAY_FAILED:" + error.GetType().Name);
      return 1;
    } finally {
      process.Dispose();
    }
  }
}
