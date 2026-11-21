/** Build a standalone DSH browser plugin using its documented lazy-CJS format. */
import { build } from 'esbuild';
import { transform } from 'lightningcss';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Shared identities supplied by the supported DSH Web platform. */
export const platformModules = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
];

/** Compile one entry without running it; CSS effects belong to factory materialization. */
export async function buildClient({ entry, outfile, id, external = [] }) {
  if (!id || !entry || !outfile) throw new Error('entry, outfile and id are required');
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs',
    platform: 'browser', target: ['es2022'], jsx: 'automatic',
    external: [...platformModules, ...external],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'robot-css-modules',
      setup(build) {
        build.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
          const source = await readFile(path);
          const compiled = transform({ filename: `${id}/${basename(path)}`, code: source, cssModules: true, minify: true });
          if (compiled.dependencies?.length) throw new Error('External CSS assets require an explicit package asset adapter');
          const classes = Object.fromEntries(Object.entries(compiled.exports ?? {}).map(([key, value]) => [key, value.name]));
          const styleId = `${id}/${basename(path)}`;
          return {
            loader: 'js', watchFiles: [path],
            contents: `const css=${JSON.stringify(compiled.code.toString())};\nconst styleId=${JSON.stringify(styleId)};\nif(typeof document!=='undefined'&&!Array.from(document.querySelectorAll('style[data-plugin-css]')).some(tag=>tag.dataset.pluginCss===styleId)){const tag=document.createElement('style');tag.dataset.plugin=${JSON.stringify(id)};tag.dataset.pluginCss=styleId;tag.textContent=css;document.head.appendChild(tag);}\nexport default ${JSON.stringify(classes)};`,
          };
        });
      },
    }],
  });
  const code = result.outputFiles[0].text;
  const output = `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{\nconst module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;\n}});\n`;
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, output);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packageDir = resolve(process.argv[2] ?? 'packages/ui-robot');
  const manifest = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
  await buildClient({ entry: resolve(packageDir, 'src/client/index.ts'), outfile: resolve(packageDir, 'lib/client.js'), id: manifest.name, external: manifest.dsh?.client?.external ?? [] });
}
