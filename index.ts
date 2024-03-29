#!/usr/bin/env node

import fetch from "node-fetch";
import JSZip from "jszip";
import fs from "fs";
import { dirname, join } from "path";
import promiseLimit from "promise-limit";

async function fetchJSON(url: string) {
  return await (await fetch(url)).json();
}

function parseCommandLineArgs() {
  const [, , strModpackUrl, targetDir] = process.argv;
  if (!strModpackUrl || strModpackUrl === "--help" || !targetDir) {
    printUsage();
    process.exit(1);
  }

  const modpackUrl = new URL(strModpackUrl);
  if (
    modpackUrl.protocol !== "curseforge:" ||
    modpackUrl.hostname !== "install"
  )
    throw new Error("bad url");

  const addonId = modpackUrl.searchParams.get("addonId");
  const fileId = modpackUrl.searchParams.get("fileId");
  if (!addonId || !fileId) throw Error("bad url");

  return { targetDir, addonId, fileId };
}

function printUsage() {
  process.stderr.write(
    "Usage: modpack-downloader modpack_url(curseforge://install/...) target_directory\n"
  );
}

async function fetchModFileInfo(
  projectId: string | number,
  fileId: string | number
): Promise<ModFileInfo> {
  return await fetchJSON(
    `https://addons-ecs.forgesvc.net/api/v2/addon/${projectId}/file/${fileId}`
  );
}

async function downloadModpack(modpackInfo: ModFileInfo) {
  const modpackZipBuffer = await (
    await fetch(modpackInfo.downloadUrl)
  ).buffer();
  const modpackZip = await JSZip.loadAsync(modpackZipBuffer);
  return modpackZip;
}

const downloadLimit = promiseLimit(6);
async function downloadMods(modpack: JSZip, targetDir: string) {
  await fs.promises.mkdir(join(targetDir, "mods"), { recursive: true });

  const manifestData = modpack.file("manifest.json");
  if (!manifestData) throw Error("invalid modpack");

  const manifest = JSON.parse(
    await manifestData.async("text")
  ) as ModpackManifest;
  let fileCount = manifest.files.length;
  process.stderr.write(`Downloading ${fileCount} files...\n`);

  let downloadedCount = 0;
  const promises = manifest.files.map(
    ({ projectID: projectId, fileID: fileId }) =>
      downloadLimit(async () => {
        const modInfo = await fetchModFileInfo(projectId, fileId);

        const stream = (await fetch(modInfo.downloadUrl)).body;
        const file = fs.createWriteStream(
          join(targetDir, "mods", modInfo.fileName)
        );
        try {
          await new Promise((resolve, reject) => {
            stream.pipe(file);
            file.on("finish", resolve);
            stream.on("error", reject);
          });
        } finally {
          file.close();
        }

        process.stderr.write(
          `(${++downloadedCount}/${fileCount}) ${modInfo.displayName}\n`
        );
      })
  );

  await Promise.all(promises);
}

async function expandOverrides(modpack: JSZip, targetDir: string) {
  process.stderr.write("Expanding overrides...");

  const overrides = modpack.folder("overrides");
  if (!overrides) throw Error("missing overrides in modpack zip");

  const entries: [string, JSZip.JSZipObject][] = [];

  overrides.forEach((path, fileData) => {
    entries.push([path, fileData]);
  });

  for (const [path, fileData] of entries) {
    if (fileData.dir) {
      await fs.promises.mkdir(join(targetDir, path), { recursive: true });
    } else {
      await fs.promises.mkdir(join(targetDir, dirname(path)), {
        recursive: true,
      });
      const fileStream = fs.createWriteStream(join(targetDir, path));
      const stream = fileData.nodeStream();
      stream.pipe(fileStream);
      try {
        await new Promise((resolve, reject) => {
          fileStream.on("finish", resolve);
          fileStream.on("error", reject);
          stream.on("error", reject);
        });
      } finally {
        fileStream.close();
      }
      process.stderr.write(`${path}\n`);
    }
  }
}
type ModFileInfo = {
  id: number;
  displayName: string;
  fileName: string;
  downloadUrl: string;
};
type ModpackManifest = {
  files: {
    projectID: number;
    fileID: number;
  }[];
};

(async () => {
  try {
    const args = parseCommandLineArgs();

    const modpackInfo = await fetchModFileInfo(args.addonId, args.fileId);
    process.stderr.write(`Modpack name: ${modpackInfo.displayName}\n`);

    process.stderr.write("Downloading modpack zip...");
    const modpack = await downloadModpack(modpackInfo);
    process.stderr.write("done\n");

    await downloadMods(modpack, args.targetDir);
    await expandOverrides(modpack, args.targetDir);

    process.stderr.write("Finish!\n");
  } catch (e) {
    console.error(e);
  }
})();
