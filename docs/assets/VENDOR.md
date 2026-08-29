# Vendored assets

`asciinema-player.min.js` and `asciinema-player.css` are the bundle build of
[asciinema-player](https://github.com/asciinema/asciinema-player) 3.17.0, copied
verbatim from the npm tarball:

```sh
npm pack asciinema-player@3.17.0
tar xzf asciinema-player-3.17.0.tgz
cp package/dist/bundle/asciinema-player.min.js package/dist/bundle/asciinema-player.css docs/assets/
```

They are checked in rather than pulled from a CDN so the landing page has no
external dependency. The bundle build is self-contained -- it loads no worker and
fetches nothing but the cast.

`demo.cast` is the recording embedded on the page. See
kb/01a04e21-40d3-733f-bbc9-5274bc42a31c.md for how it is produced.
