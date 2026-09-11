/**
 * Monaco Editor 用: 文件名 → Monaco language ID
 * 支持无扩展名的特殊文件名 (Dockerfile, Makefile, .env 等)
 */
export function detectLanguageForMonaco(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.toLowerCase() ?? filename.toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()! : "";

  // Special filenames (no extension or compound names)
  const nameMap: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
    "env.example": "ini",
    ".env": "ini",
    vagrantfile: "ruby",
    gemfile: "ruby",
    rakefile: "ruby",
    cmakelists: "cmake",
  };
  if (nameMap[base]) return nameMap[base];

  // Double extensions
  const dbl = base.split(".");
  if (dbl.length >= 3) {
    const dblExt = dbl.slice(-2).join(".");
    const dblMap: Record<string, string> = {
      "d.ts": "typescript",
      "test.ts": "typescript", "test.tsx": "typescript", "spec.ts": "typescript", "spec.tsx": "typescript",
      "test.js": "javascript", "test.jsx": "javascript", "spec.js": "javascript", "spec.jsx": "javascript",
      "min.js": "javascript", "min.css": "css",
      "module.css": "css", "global.css": "css",
      "docker-compose.yml": "yaml", "docker-compose.yaml": "yaml",
      "gitlab-ci.yml": "yaml", "circleci.yml": "yaml",
      "nginx.conf": "nginx",
    };
    if (dblMap[dblExt]) return dblMap[dblExt];
  }

  // Extension map (alphabetic by ext)
  const extMap: Record<string, string> = {
    // ── Web ──
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
    html: "html", htm: "html", xhtml: "html",
    css: "css", scss: "scss", sass: "sass", less: "less", styl: "stylus",
    json: "json", jsonc: "json", json5: "json",
    xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", svg: "xml",
    vue: "html", svelte: "html", astro: "html",

    // ── Scripting ──
    py: "python", pyw: "python", pyx: "python", ipynb: "json",
    rb: "ruby", php: "php", phtml: "php", php3: "php", php4: "php", php5: "php",
    lua: "lua", pl: "perl", pm: "perl", t: "perl",
    r: "r", R: "r", rmd: "r",

    // ── Systems / Native ──
    c: "c", h: "c", cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp", hh: "cpp",
    cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin",
    swift: "swift", scala: "scala", sc: "scala",
    rs: "rust", go: "go",
    m: "objective-c", mm: "objective-c",
    f90: "fortran", f95: "fortran", f03: "fortran",

    // ── Shell / Config ──
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    bat: "bat", cmd: "bat",
    yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", cfg: "ini", conf: "ini", config: "ini",
    properties: "ini", env: "ini", editorconfig: "ini",
    dockerignore: "ini", gitignore: "ini", gitattributes: "ini",

    // ── Data / Markup ──
    md: "markdown", mdx: "markdown", markdown: "markdown",
    rst: "restructuredtext", tex: "latex", bib: "bibtex",
    csv: "plaintext", tsv: "plaintext",
    graphql: "graphql", gql: "graphql",
    proto: "protobuf",
    sql: "sql", psql: "sql", mysql: "sql",

    // ── Templates ──
    ejs: "html", hbs: "handlebars", handlebars: "handlebars",
    mustache: "handlebars", twig: "twig", blade: "php",
    j2: "jinja", jinja: "jinja", jinja2: "jinja",

    // ── Misc ──
    diff: "diff", patch: "diff",
    log: "plaintext", lock: "plaintext",
    coffee: "coffeescript", litcoffee: "coffeescript",
    dart: "dart",
    elm: "elm",
    erl: "erlang", hrl: "erlang",
    ex: "elixir", exs: "elixir",
    fs: "fsharp", fsx: "fsharp", fsi: "fsharp",
    hs: "haskell", lhs: "haskell",
    clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
    groovy: "groovy", gradle: "groovy",
    jl: "julia",
    ml: "ocaml", mli: "ocaml",
    nim: "nim", nims: "nim",
    pas: "pascal", pp: "pascal",
    zig: "plaintext",
    tf: "plaintext", tfvars: "plaintext", hcl: "plaintext",
    prisma: "plaintext",
  };
  return extMap[ext] ?? "plaintext";
}

/**
 * StatusBar 用: 文件名 → 人类可读标签
 */
export function detectLanguageLabel(filename: string): string {
  const langId = detectLanguageForMonaco(filename);
  const labelMap: Record<string, string> = {
    typescript: "TypeScript", javascript: "JavaScript",
    html: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", stylus: "Stylus",
    json: "JSON", xml: "XML", svg: "SVG",
    markdown: "Markdown", restructuredtext: "reStructuredText",
    python: "Python", ruby: "Ruby", php: "PHP", perl: "Perl", lua: "Lua", r: "R",
    c: "C", cpp: "C++", csharp: "C#", java: "Java", kotlin: "Kotlin",
    swift: "Swift", scala: "Scala", rust: "Rust", go: "Go",
    "objective-c": "Objective-C", fortran: "Fortran",
    shell: "Shell", powershell: "PowerShell", bat: "Batch",
    yaml: "YAML", ini: "Config", toml: "TOML",
    graphql: "GraphQL", protobuf: "Protobuf", sql: "SQL",
    handlebars: "Handlebars", twig: "Twig", jinja: "Jinja",
    latex: "LaTeX", bibtex: "BibTeX",
    diff: "Diff", dockerfile: "Dockerfile", makefile: "Makefile",
    coffeescript: "CoffeeScript", dart: "Dart", elm: "Elm",
    erlang: "Erlang", elixir: "Elixir", fsharp: "F#", haskell: "Haskell",
    clojure: "Clojure", groovy: "Groovy", julia: "Julia",
    ocaml: "OCaml", nim: "Nim", pascal: "Pascal",
  };
  return labelMap[langId] ?? (langId.charAt(0).toUpperCase() + langId.slice(1));
}
