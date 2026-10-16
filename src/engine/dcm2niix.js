// Thin runner around the dcm2niix WebAssembly build (BSD-licensed, by Chris Rorden et al.).
// A fresh module instance is created for every run, so memory is released between series and
// no global state leaks from one conversion into the next.

export class Dcm2niixRunner {
  /**
   * @param {Function} factory Emscripten module factory (default export of dcm2niix.jpeg.js)
   * @param {Uint8Array|ArrayBuffer} wasmBinary the compiled dcm2niix.jpeg.wasm bytes
   */
  constructor(factory, wasmBinary) {
    this.factory = factory;
    this.wasmBinary = wasmBinary;
  }

  /**
   * Run dcm2niix on a flat list of files.
   * @param {{name:string, bytes:Uint8Array}[]} files
   * @param {string[]} args dcm2niix options (without -o and input folder)
   * @returns {Promise<{exitCode:number, outputs:{name:string,bytes:Uint8Array}[], log:string[]}>}
   */
  async run(files, args) {
    const log = [];
    const mod = await this.factory({
      wasmBinary: this.wasmBinary,
      print: (s) => log.push(String(s)),
      printErr: (s) => log.push(String(s)),
      noExitRuntime: true,
    });
    const FS = mod.FS;
    FS.mkdir('/in'); FS.mkdir('/out');
    files.forEach((f, i) => FS.writeFile(`/in/${String(i).padStart(6, '0')}_${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}`, f.bytes));
    let exitCode = 0;
    try {
      exitCode = mod.callMain(['-o', '/out', ...args, '/in']);
    } catch (e) {
      if (e && typeof e === 'object' && 'status' in e) exitCode = e.status;
      else throw e;
    }
    const outputs = [];
    for (const name of FS.readdir('/out')) {
      if (name === '.' || name === '..') continue;
      outputs.push({ name, bytes: FS.readFile(`/out/${name}`) });
    }
    return { exitCode: exitCode ?? 0, outputs, log };
  }
}
