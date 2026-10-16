import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = join(root, "native");
const code = await new Promise((done, fail) => {
    const child = spawn("cargo", ["build", "--release", "--locked", "--manifest-path", join(native, "Cargo.toml")],
        { cwd: root, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", fail); child.once("exit", done);
});
if (code !== 0) process.exit(code || 1);
const library = process.platform === "win32" ? "grafly_xerj.dll" : process.platform === "darwin" ? "libgrafly_xerj.dylib" : "libgrafly_xerj.so";
const output = join(root, "dist", "search", "native");
mkdirSync(output, { recursive: true });
copyFileSync(join(native, "target", "release", library), join(output, `xerj-${process.platform}-${process.arch}.node`));
console.log(`Built embedded XERJ for ${process.platform}-${process.arch}`);
