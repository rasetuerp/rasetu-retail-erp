/**
 * TSC TTP-244 Pro Printer API
 * Handles USB communication and print job management
 */

import { TscPrinterDriver, type LabelTemplate, type PrinterSettings } from './printer-driver.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { SerialPort } from 'serialport';
import { readPrinterConfig, writePrinterConfig, type PrinterRole } from './printer-config.js';

export interface PrintJobResult {
  success: boolean;
  message: string;
  jobId?: string;
  error?: string;
  printerName?: string;
  timestamp?: string;
}

export interface PrinterStatus {
  name: string;
  isConnected: boolean;
  model: string;
  dpi: number;
  transport?: 'system-spooler' | 'serial' | 'none';
  availablePrinters?: string[];
  availablePorts?: string[];
  error?: string;
  lastUsed?: Date;
  totalJobsPrinted: number;
}

/**
 * Manage printer communication and print jobs
 */
export class PrinterManager {
  private printerDriver: TscPrinterDriver;
  private settings: PrinterSettings;
  private printHistory: Map<string, any> = new Map();
  private jobCounter: number = 0;
  private serialPort: SerialPort | null = null;
  private portPath: string | null = null;
  private detectedPrinterQueue: string | null = null;
  private readonly role: PrinterRole;

  constructor(role: PrinterRole, printerName: string = 'TSC TTP-244 Pro', settings?: Partial<PrinterSettings>) {
    this.role = role;
    this.settings = {
      name: printerName,
      dpi: 203,
      labelWidth: 101.6,
      labelHeight: 100,
      gapLength: 3.5,
      darknessFactor: 5,
      autoGapDetection: true,
      marginTop: 2,
      marginLeft: 2,
      marginRight: 2,
      marginBottom: 2,
      ...settings,
    };

    this.printerDriver = new TscPrinterDriver(this.settings);
  }

  /**
   * Detect available serial ports
   */
  async detectPorts(): Promise<string[]> {
    try {
      const ports = await SerialPort.list();
      const tscPorts = ports.filter(port =>
        port.vendorId && port.productId &&
        (port.vendorId.includes('0666') || // TSC vendor ID
         port.productId.includes('0202') || // TTP-244 product ID
         port.manufacturer?.includes('TSC') ||
         port.path.includes('COM'))
      );

      return tscPorts.map(p => p.path);
    } catch (error) {
      console.error('[Printer] Port detection failed:', error);
      return [];
    }
  }

  /**
   * Detect OS printer queues. TSC USB printers normally appear here,
   * not as serial ports, unless the driver exposes a virtual COM port.
   */
  async listSystemPrinters(): Promise<string[]> {
    if (process.platform === 'win32') return this.listWindowsPrinters();
    if (process.platform === 'darwin') return this.listMacPrinters();
    return [];
  }

  /**
   * Backward-compatible Windows queue listing.
   */
  async listWindowsPrinters(): Promise<string[]> {
    if (process.platform !== 'win32') return [];

    try {
      const output = await this.runPowerShell([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-Printer | Select-Object -ExpandProperty Name',
      ]);

      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      console.error('[Printer] Windows printer detection failed:', error);
      return [];
    }
  }

  /**
   * Detect macOS CUPS printer queues.
   */
  async listMacPrinters(): Promise<string[]> {
    if (process.platform !== 'darwin') return [];

    try {
      const output = await this.runCommand('lpstat', ['-e']);
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      console.error('[Printer] macOS printer detection failed:', error);
      return [];
    }
  }

  /**
   * Connect to printer via USB serial port
   */
  async connectToPort(portPath: string): Promise<boolean> {
    try {
      // Close existing connection if any
      if (this.serialPort?.isOpen) {
        await new Promise<void>((resolve, reject) => {
          this.serialPort!.close((error) => (error ? reject(error) : resolve()));
        });
      }

      // Open new connection to TSC printer
      this.serialPort = new SerialPort({
        path: portPath,
        baudRate: 115200, // TSC TTP-244 Pro standard baud rate
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });

      // Wait for port to be ready
      await new Promise<void>((resolve, reject) => {
        this.serialPort!.on('open', () => {
          console.log(`[Printer] Connected to ${portPath}`);
          resolve();
        });
        this.serialPort!.on('error', (err) => {
          console.error(`[Printer] Failed to open port ${portPath}:`, err);
          reject(err);
        });

        // Timeout after 5 seconds
        setTimeout(() => reject(new Error('Port connection timeout')), 5000);
      });

      this.portPath = portPath;
      return true;
    } catch (error) {
      console.error('[Printer] Connection error:', error);
      return false;
    }
  }

  /**
   * Initialize printer and test connection
   */
  async testConnection(): Promise<PrinterStatus> {
    try {
      console.log(`[Printer] Testing connection to: ${this.settings.name}`);

      const systemPrinters = await this.listSystemPrinters();
      this.detectedPrinterQueue = this.resolvePrinterQueue(systemPrinters);
      if (this.detectedPrinterQueue) {
        return {
          name: this.detectedPrinterQueue,
          isConnected: true,
          model: 'TSC TTP-244 Pro',
          dpi: this.settings.dpi,
          transport: 'system-spooler',
          availablePrinters: systemPrinters,
          availablePorts: [],
          totalJobsPrinted: this.printHistory.size,
        };
      }

      const ports = await this.detectPorts();
      let isConnected = false;

      if (ports.length > 0) {
        // Try first available port
        isConnected = await this.connectToPort(ports[0]);
      } else {
        // Fallback: try common COM ports
        const commonPorts = ['COM1', 'COM3', 'COM4', 'COM5', '/dev/ttyUSB0', '/dev/ttyACM0'];
        for (const port of commonPorts) {
          const connected = await this.connectToPort(port);
          if (connected) {
            isConnected = true;
            break;
          }
        }
      }

      if (!isConnected && !this.serialPort?.isOpen) {
        console.warn('[Printer] No printer detected, using simulation mode');
      }

      return {
        name: this.settings.name,
        isConnected: this.serialPort?.isOpen ?? false,
        model: 'TSC TTP-244 Pro',
        dpi: this.settings.dpi,
        transport: this.serialPort?.isOpen ? 'serial' : 'none',
        availablePrinters: this.portPath ? [...systemPrinters, `Serial: ${this.portPath}`] : systemPrinters,
        availablePorts: ports,
        totalJobsPrinted: this.printHistory.size,
      };
    } catch (error) {
      console.error('[Printer] Connection test failed:', error);
      return {
        name: this.settings.name,
        isConnected: false,
        model: 'TSC TTP-244 Pro',
        dpi: this.settings.dpi,
        transport: 'none',
        error: error instanceof Error ? error.message : String(error),
        totalJobsPrinted: this.printHistory.size,
      };
    }
  }

  /**
   * Print a single label
   */
  async printLabel(
    template: LabelTemplate,
    data: Record<string, string | number>,
    copies: number = 1
  ): Promise<PrintJobResult> {
    try {
      const status = await this.testConnection();
      if (!status.isConnected) {
        const printers = status.availablePrinters?.length
          ? ` Printer queues: ${status.availablePrinters.join(', ')}.`
          : '';
        const ports = status.availablePorts?.length
          ? ` Serial ports: ${status.availablePorts.join(', ')}.`
          : '';
        throw new Error(`Printer not connected or not found as "${this.settings.name}".${printers}${ports}`);
      }

      const jobId = this.generateJobId();
      const timestamp = new Date().toISOString();

      // Build label data for each copy
      for (let i = 0; i < copies; i++) {
        const labelBuffer = this.printerDriver.buildLabel(template, data);

        // Log the print job
        console.log(`[Printer] Printing label ${i + 1}/${copies}, Job: ${jobId}`);

        // Send to printer (in real implementation, via USB)
        await this.sendToPrinter(labelBuffer);

        // Small delay between copies
        if (i < copies - 1) {
          await this.delay(500);
        }
      }

      // Record in history
      this.recordPrintJob({
        jobId,
        template: template.name,
        data,
        copies,
        timestamp,
        status: 'SUCCESS',
      });

      return {
        success: true,
        message: `Successfully printed ${copies} label(s)`,
        jobId,
        printerName: this.settings.name,
        timestamp,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Printer] Print job failed:', message);

      return {
        success: false,
        message: 'Print job failed',
        error: message,
      };
    }
  }

  /**
   * Print already-generated printer commands exactly as supplied by the
   * renderer. Label Designer uses this path so the live preview and physical
   * print share the same ZPL coordinate engine.
   */
  async printRawCommands(
    commands: string,
    copies: number = 1,
    jobName: string = 'RaSetu Raw Label'
  ): Promise<PrintJobResult> {
    try {
      const status = await this.testConnection();
      if (!status.isConnected) {
        const printers = status.availablePrinters?.length
          ? ` Printer queues: ${status.availablePrinters.join(', ')}.`
          : '';
        const ports = status.availablePorts?.length
          ? ` Serial ports: ${status.availablePorts.join(', ')}.`
          : '';
        throw new Error(`Printer not connected or not found as "${this.settings.name}".${printers}${ports}`);
      }

      const jobId = this.generateJobId();
      const timestamp = new Date().toISOString();
      const normalizedCommands = this.normalizeRawPrinterCommands(commands);
      const rawBuffer = Buffer.from(normalizedCommands, 'ascii');
      console.log(`[Printer] Raw command preview: ${normalizedCommands.split(/\r\n/).slice(0, 6).join(' | ')}`);

      for (let i = 0; i < Math.max(1, copies); i++) {
        console.log(`[Printer] Printing raw label ${i + 1}/${copies}, Job: ${jobId}`);
        await this.sendToPrinter(rawBuffer);
        if (i < copies - 1) await this.delay(150);
      }

      this.recordPrintJob({
        jobId,
        template: jobName,
        data: { bytes: rawBuffer.length },
        copies,
        timestamp,
        status: 'SUCCESS',
      });

      return {
        success: true,
        message: `Successfully printed ${copies} raw label(s)`,
        jobId,
        printerName: this.settings.name,
        timestamp,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Printer] Raw print job failed:', message);
      return {
        success: false,
        message: 'Raw print job failed',
        error: message,
      };
    }
  }

  /**
   * Print a test label for calibration
   */
  async printTestLabel(): Promise<PrintJobResult> {
    try {
      const jobId = this.generateJobId();
      const timestamp = new Date().toISOString();

      console.log(`[Printer] Printing test label, Job: ${jobId}`);

      const status = await this.testConnection();
      if (!status.isConnected) {
        throw new Error(`Printer not connected or not found as "${this.settings.name}"`);
      }

      // Generate test label from driver
      const testLabelBuffer = this.printerDriver.generateTestLabel();

      // Send to printer
      await this.sendToPrinter(testLabelBuffer);

      this.recordPrintJob({
        jobId,
        template: 'TEST',
        data: {},
        copies: 1,
        timestamp,
        status: 'SUCCESS',
      });

      return {
        success: true,
        message: 'Test label sent to printer - check your printer',
        jobId,
        printerName: this.settings.name,
        timestamp,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: 'Test print failed',
        error: message,
      };
    }
  }

  /**
   * Print batch of labels
   */
  async printBatch(
    labels: Array<{
      template: LabelTemplate;
      data: Record<string, string | number>;
      copies: number;
    }>
  ): Promise<PrintJobResult> {
    try {
      const jobId = this.generateJobId();
      let successCount = 0;
      let totalCopies = 0;

      for (const label of labels) {
        totalCopies += label.copies;
        const result = await this.printLabel(label.template, label.data, label.copies);
        if (result.success) {
          successCount++;
        }
      }

      this.recordPrintJob({
        jobId,
        template: 'BATCH',
        data: { labelCount: labels.length },
        copies: totalCopies,
        timestamp: new Date().toISOString(),
        status: 'SUCCESS',
      });

      return {
        success: successCount === labels.length,
        message: `Printed ${successCount}/${labels.length} batches (${totalCopies} total labels)`,
        jobId,
        printerName: this.settings.name,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: 'Batch print failed',
        error: message,
      };
    }
  }

  /**
   * Calibrate printer gap detection
   */
  async calibrate(): Promise<PrintJobResult> {
    try {
      console.log('[Printer] Starting calibration...');

      // Send gap detection commands
      const gapLength = await this.detectGapLength();
      console.log(`[Printer] Detected gap length: ${gapLength}mm`);

      this.settings.gapLength = gapLength;

      return {
        success: true,
        message: `Printer calibrated. Gap length: ${gapLength}mm`,
        printerName: this.settings.name,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: 'Calibration failed',
        error: message,
      };
    }
  }

  /**
   * Update printer settings
   */
  updateSettings(newSettings: Partial<PrinterSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.printerDriver.updateSettings(this.settings);
    console.log('[Printer] Settings updated:', this.settings);

    // Round 23 — settings used to live only in this in-memory object, so
    // every save was silently lost on the next app restart. Persist under
    // this manager's own role so the receipt and label printers don't clobber
    // each other's saved config.
    const config = readPrinterConfig();
    if (this.role === 'label') {
      config.label = this.settings;
    } else {
      config.receipt.printerName = this.settings.name;
    }
    writePrinterConfig(config);
  }

  /**
   * Get current printer settings
   */
  getSettings(): PrinterSettings {
    return { ...this.settings };
  }

  /**
   * Get print history
   */
  getPrintHistory(limit: number = 100): any[] {
    return Array.from(this.printHistory.values()).slice(-limit);
  }

  /**
   * Clear print history
   */
  clearHistory(): void {
    this.printHistory.clear();
    console.log('[Printer] History cleared');
  }

  /**
   * Get printer statistics
   */
  getStats(): {
    totalJobsPrinted: number;
    totalLabelsPrinted: number;
    averageJobSize: number;
  } {
    const jobs = Array.from(this.printHistory.values());
    const totalJobs = jobs.length;
    const totalLabels = jobs.reduce((sum, job) => sum + (job.copies || 1), 0);

    return {
      totalJobsPrinted: totalJobs,
      totalLabelsPrinted: totalLabels,
      averageJobSize: totalJobs > 0 ? totalLabels / totalJobs : 0,
    };
  }

  // --- Private Methods ---

  /**
   * Send data to printer via USB serial port
   */
  private async sendToPrinter(data: Buffer): Promise<void> {
    try {
      console.log(`[Printer] Sending ${data.length} bytes to printer...`);

      if (process.platform === 'win32' || process.platform === 'darwin') {
        const targetPrinter = this.detectedPrinterQueue || this.settings.name;
        if (targetPrinter && !/^COM\d+$/i.test(targetPrinter)) {
          if (process.platform === 'darwin') {
            await this.sendRawToMacPrinter(targetPrinter, data);
            console.log(`[Printer] Raw label commands sent to macOS printer: ${targetPrinter}`);
            return;
          }

          await this.sendRawToWindowsPrinter(targetPrinter, data);
          console.log(`[Printer] Raw label commands sent to Windows printer: ${targetPrinter}`);
          return;
        }
      }

      if (!this.serialPort?.isOpen) {
        console.log('[Printer] Attempting to auto-connect to printer...');
        const connected = await this.testConnection();
        if (!connected.isConnected) {
          throw new Error('No printer queue or serial port is available for this printer');
        }
      }

      // Send data to printer
      return new Promise<void>((resolve, reject) => {
        if (!this.serialPort || !this.serialPort.isOpen) {
          reject(new Error('Serial port is not open'));
          return;
        }

        this.serialPort.write(data, (err) => {
          if (err) {
            console.error('[Printer] Send error:', err);
            reject(new Error(`Failed to send data to printer: ${err.message}`));
            return;
          }

          console.log('[Printer] Data sent successfully');

          this.serialPort!.drain((drainError) => {
            if (drainError) {
              reject(new Error(`Failed to flush data to printer: ${drainError.message}`));
              return;
            }

            setTimeout(resolve, 300);
          });
        });
      });
    } catch (error) {
      console.error('[Printer] Error sending data:', error);
      throw error;
    }
  }

  private normalizeRawPrinterCommands(commands: string): string {
    const normalized = commands
      .replace(/₹/g, 'Rs.')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
      .replace(/\r?\n/g, '\r\n')
      .trimEnd();

    return `${normalized}\r\n`;
  }

  private resolvePrinterQueue(printerNames: string[]): string | null {
    const requested = this.settings.name.trim().toLowerCase();
    const exact = printerNames.find((name) => name.trim().toLowerCase() === requested);
    if (exact) return exact;

    const likelyTsc = printerNames.find((name) => /tsc|ttp|244|thermal|label/i.test(name));
    return likelyTsc || null;
  }

  private async sendRawToMacPrinter(printerName: string, data: Buffer): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rasetu-print-'));
    const rawPath = path.join(tempDir, 'label.tspl');

    fs.writeFileSync(rawPath, data);

    try {
      await this.runCommand('lpr', ['-P', printerName, '-o', 'raw', rawPath]);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Temporary print files are best-effort cleanup.
      }
    }
  }

  private async sendRawToWindowsPrinter(printerName: string, data: Buffer): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rasetu-print-'));
    const rawPath = path.join(tempDir, 'label.tspl');
    const scriptPath = path.join(tempDir, 'raw-print.ps1');

    fs.writeFileSync(rawPath, data);
    fs.writeFileSync(scriptPath, this.getRawPrintPowerShellScript(), 'utf8');

    try {
      await this.runPowerShell([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        printerName,
        rawPath,
      ]);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Temporary print files are best-effort cleanup.
      }
    }
  }

  private getRawPrintPowerShellScript(): string {
    return `
param([string]$PrinterName, [string]$FilePath)
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);

  public static void SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    }

    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "RaSetu Thermal Label";
      di.pDataType = "RAW";

      if (!StartDocPrinter(hPrinter, 1, di)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      try {
        if (!StartPagePrinter(hPrinter)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
        try {
          int written;
          if (!WritePrinter(hPrinter, bytes, bytes.Length, out written)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed");
          if (written != bytes.Length) throw new Exception("Only wrote " + written + " of " + bytes.Length + " bytes");
        } finally {
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::SendBytes($PrinterName, $bytes)
`;
  }

  private async runPowerShell(args: string[]): Promise<string> {
    return this.runCommand('powershell.exe', args, { windowsHide: true });
  }

  private async runCommand(command: string, args: string[], options: { windowsHide?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      });
    });
  }

  /**
   * Detect gap length via gap sensor
   */
  private async detectGapLength(): Promise<number> {
    // Simulate gap detection
    await this.delay(2000);

    // Return typical gap length (3.5mm for hangtags)
    return 3.5;
  }

  /**
   * Generate unique job ID
   */
  private generateJobId(): string {
    this.jobCounter++;
    return `JOB-${Date.now()}-${this.jobCounter}`;
  }

  /**
   * Record print job in history
   */
  private recordPrintJob(job: any): void {
    this.printHistory.set(job.jobId, {
      ...job,
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * Close serial port connection
   */
  async disconnect(): Promise<void> {
    try {
      if (this.serialPort && this.serialPort.isOpen) {
        await new Promise<void>((resolve, reject) => {
          this.serialPort!.close((error) => (error ? reject(error) : resolve()));
        });
        this.serialPort = null;
        this.portPath = null;
        console.log('[Printer] Disconnected from printer');
      }
    } catch (error) {
      console.error('[Printer] Error closing port:', error);
    }
  }

  /**
   * Delay helper for async operations
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Round 23 — one PrinterManager per role (receipt vs label), instead of a
 * single global singleton. Before this, thermal receipts and barcode labels
 * shared one printer/settings object, so a shop with two separate physical
 * printers had no way to tell RaSetu which was which.
 */
const printerManagers = new Map<PrinterRole, PrinterManager>();

/**
 * Get or create the printer manager for a role, seeded from the persisted
 * printer-config.json on first access.
 */
export function getPrinterManager(role: PrinterRole = 'label'): PrinterManager {
  let manager = printerManagers.get(role);
  if (!manager) {
    const config = readPrinterConfig();
    manager =
      role === 'label'
        ? new PrinterManager('label', config.label.name || 'TSC TTP-244 Pro', config.label)
        : new PrinterManager('receipt', config.receipt.printerName || 'TSC TTP-244 Pro');
    printerManagers.set(role, manager);
  }
  return manager;
}

/**
 * Initialize both printer managers in the Electron main process.
 */
export function initializePrinterManager(): void {
  getPrinterManager('label');
  getPrinterManager('receipt');
  console.log('[Printer] Managers initialized (receipt + label)');
}
