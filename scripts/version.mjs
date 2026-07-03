// Prints the CalVer version for the current UTC date.
//   default:    yyyy.m.d-<utc epoch millis>  (dev build)
//   --release:  yyyy.m.d                     (release build)
const now = new Date();
const base = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
const isRelease = process.argv.includes("--release");
console.log(isRelease ? base : `${base}-${now.getTime()}`);
