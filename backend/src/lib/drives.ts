import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import drivelist from 'drivelist';

const execFileAsync = promisify(execFile);

// Round 9 — multi-company portable storage. `drivelist` enumerates physical
// disks and their current drive-letter mountpoints, but (confirmed by
// inspecting its actual output on this machine) does NOT expose a stable
// per-volume identifier — only a physical-disk device path, which is no help
// once you're below the "which disk" level. Windows drive letters are not
// stable across reboots/plug order, so a design that stores "E:\" as a
// company's location would silently break or (worse) match a different
// drive that later gets reassigned the same letter.
//
// The stable identifier actually used here is PowerShell's `Get-Volume`
// `UniqueId` (a `\\?\Volume{guid}\` string tied to the formatted volume
// itself, not the drive letter) — captured once at company-creation time and
// re-matched against whatever drive letter that volume currently has every
// time presence needs checking. This is why `listDrives()` shells out to
// `Get-Volume` per mountpoint instead of trusting `drivelist` alone.
export type DriveInfo = {
  mountpoint: string; // e.g. "E:\\"
  driveLetter: string; // e.g. "E"
  label: string | null;
  volumeId: string;
  isRemovable: boolean;
  isSystem: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
};

type VolumeJson = {
  FileSystemLabel?: string | null;
  UniqueId?: string;
  SizeRemaining?: number;
  Size?: number;
};

async function getVolumeInfo(driveLetter: string): Promise<VolumeJson | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Volume -DriveLetter ${driveLetter} | Select-Object -Property FileSystemLabel,UniqueId,SizeRemaining,Size | ConvertTo-Json -Compress`,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as VolumeJson;
  } catch {
    return null; // e.g. a drive with no mounted filesystem — skip it
  }
}

/** Every currently-mounted drive with a stable volume id, for the storage-location picker (Round 9) and company presence checks. Windows-only (RaSetu ships NSIS/Windows — see electron-builder.yml). */
export async function listDrives(): Promise<DriveInfo[]> {
  const disks = await drivelist.list();
  const results: DriveInfo[] = [];

  for (const disk of disks) {
    for (const mountpoint of disk.mountpoints) {
      const driveLetter = mountpoint.path.replace(/\\$/, '').replace(/:$/, '');
      const volume = await getVolumeInfo(driveLetter);
      if (!volume?.UniqueId) continue; // can't reliably track this one — leave it out rather than risk a fragile letter-only match

      results.push({
        mountpoint: mountpoint.path,
        driveLetter,
        label: volume.FileSystemLabel || null,
        volumeId: volume.UniqueId,
        isRemovable: disk.isRemovable,
        isSystem: disk.isSystem,
        freeBytes: volume.SizeRemaining ?? null,
        totalBytes: volume.Size ?? null,
      });
    }
  }

  return results;
}

/** Finds the drive currently holding a given volume id, or null if it's not plugged in right now. */
export async function findDriveByVolumeId(volumeId: string): Promise<DriveInfo | null> {
  const drives = await listDrives();
  return drives.find((d) => d.volumeId === volumeId) ?? null;
}
