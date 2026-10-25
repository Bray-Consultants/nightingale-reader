// Puts the Nightingale icon and name into the Windows .exe (pure JS, no Windows tools needed).
// Usage: npm run stamp-exe -- "<path to electron.exe>" "<output Nightingale Reader.exe>" assets/icon.ico 0.5.0
const ResEdit = require('resedit'); const PE = require('pe-library'); const fs = require('fs');
const [src, out, ico, ver] = process.argv.slice(2);
const exe = PE.NtExecutable.from(fs.readFileSync(src), { ignoreCert: true });
const res = PE.NtExecutableResource.from(exe);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map((i) => i.data));
const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const lang = { lang: 1033, codepage: 1200 };
vi.setStringValues(lang, {
  CompanyName: 'Bray Consultants', FileDescription: 'Nightingale Reader', ProductName: 'Nightingale Reader',
  InternalName: 'Nightingale Reader', OriginalFilename: 'Nightingale Reader.exe',
  LegalCopyright: 'Bray Consultants. Built with Electron (MIT).', FileVersion: ver, ProductVersion: ver,
});
vi.removeStringValue(lang, 'SquirrelAwareVersion');
const [a, b, c] = ver.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(out, Buffer.from(exe.generate()));
// read back to prove it
const chk = PE.NtExecutableResource.from(PE.NtExecutable.from(fs.readFileSync(out), { ignoreCert: true }));
const g = ResEdit.Resource.IconGroupEntry.fromEntries(chk.entries)[0];
const v = ResEdit.Resource.VersionInfo.fromEntries(chk.entries)[0].getStringValues(lang);
console.log('icons:', g.icons.map((i) => (i.width || 256) + 'px').join(' '), '| name:', v.ProductName, '| version:', v.FileVersion, '| company:', v.CompanyName);
