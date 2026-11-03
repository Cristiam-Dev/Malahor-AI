import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";

const ASSET_SKILLS_DIR = path.join(process.cwd(), "assets", "skills");
const MANIFEST_FILE = ".malahor-managed.json";
const roots: string[] = [];

interface OpenCodeSkillsModule {
  syncOpenCodeSkills(sourceDir: string, paths: MalahorPaths, dryRun: boolean): unknown;
  removeOpenCodeSkills(paths: MalahorPaths, dryRun: boolean): unknown;
  openCodeSkillsProblems(sourceDir: string, paths: MalahorPaths): string[];
}

async function loadSkillsModule(): Promise<OpenCodeSkillsModule> {
  const modulePath = "../src/cli/core/opencode-skills";
  return await import(modulePath) as unknown as OpenCodeSkillsModule;
}

function scratch(): string {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-opencode-skills-"));
  roots.push(root);
  return root;
}

function pathsFor(root: string): MalahorPaths {
  return resolvePaths({
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    MALAHOR_HOME: path.join(root, "home", ".malahor"),
    MALAHOR_CONFIG: path.join(root, "home", ".malahor", "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(root, "home", ".config", "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, path.join(root, "repo"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function sourceSkill(source: string, relative: string, marker: string): void {
  const title = relative.replace(/\.md$/, "");
  write(path.join(source, relative), `# ${title}\n\n${marker}.\n\n## Uso\n\n- Fixture aislado.\n`);
}

function fixtureCatalog(root: string, entries: Record<string, string> = {}): string {
  const source = path.join(root, "source", "skills");
  sourceSkill(source, "git-commit-text.md", "Genera mensajes de commit canónicos");
  for (const [relative, marker] of Object.entries(entries)) sourceSkill(source, relative, marker);
  return source;
}

function skillsDir(paths: MalahorPaths): string {
  return path.join(paths.opencodeDir, "skills");
}

function publishedSkill(paths: MalahorPaths, id: string): string {
  return path.join(skillsDir(paths), id, "SKILL.md");
}

function markdownFiles(directory: string, base = directory): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(absolute, base);
      return entry.isFile() && entry.name.endsWith(".md") ? [path.relative(base, absolute)] : [];
    });
}

function portableId(relative: string): string {
  return relative.replace(/\.md$/, "").split(path.sep).join("-");
}

function snapshot(directory: string): string {
  if (!fs.existsSync(directory)) return "<missing>";
  const entries: Array<[string, "directory" | "file", string?]> = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(absolute);
      } else {
        entries.push([relative, "file", fs.readFileSync(absolute, "utf8")]);
      }
    }
  };
  visit(directory);
  return JSON.stringify(entries);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("catálogo gestionado de skills para OpenCode V2", () => {
  test("publica cada Markdown como un ID plano portable con SKILL.md, name y description", async () => {
    const { openCodeSkillsProblems, syncOpenCodeSkills } = await loadSkillsModule();
    const paths = pathsFor(scratch());

    syncOpenCodeSkills(ASSET_SKILLS_DIR, paths, false);

    const expectedIds = markdownFiles(ASSET_SKILLS_DIR).map(portableId).sort();
    const destination = skillsDir(paths);
    const rootEntries = fs.readdirSync(destination, { withFileTypes: true });
    const publishedIds = rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const unexpectedFiles = rootEntries
      .filter((entry) => entry.isFile() && entry.name !== MANIFEST_FILE)
      .map((entry) => entry.name);

    expect(publishedIds).toEqual(expectedIds);
    expect(unexpectedFiles).toEqual([]);
    expect(publishedIds).toContain("programming-frontend-angular");
    expect(publishedIds).toContain("git-commit-text");
    expect(publishedIds).toContain("planificacion-verificada");
    expect(fs.existsSync(path.join(destination, MANIFEST_FILE))).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(path.join(destination, MANIFEST_FILE), "utf8"))).not.toThrow();

    for (const id of publishedIds) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect([...id].length).toBeLessThanOrEqual(64);
      expect(fs.readdirSync(path.join(destination, id))).toEqual(["SKILL.md"]);

      const content = fs.readFileSync(publishedSkill(paths, id), "utf8");
      expect(content).toContain(`\n# ${id}\n`);
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
      expect(frontmatter, `${id} debe tener frontmatter YAML`).toBeDefined();
      expect(frontmatter).toContain(`name: ${id}`);
      const description = /^description:\s*(.+)$/m.exec(frontmatter ?? "")?.[1]?.trim();
      expect(description, `${id} debe anunciar una description no vacía`).toBeTruthy();
      expect(description === "''" || description === '""').toBe(false);
    }
    expect(openCodeSkillsProblems(ASSET_SKILLS_DIR, paths)).toEqual([]);
  });

  test("actualiza una skill acreditada y conserva skills propias no gestionadas", async () => {
    const { syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const source = fixtureCatalog(root, {
      "programming/frontend/angular.md": "versión gestionada uno",
    });

    syncOpenCodeSkills(source, paths, false);
    const foreign = publishedSkill(paths, "mi-skill");
    const foreignContent = "---\nname: mi-skill\ndescription: Skill instalada por la persona\n---\n\n# propia\n";
    write(foreign, foreignContent);
    sourceSkill(source, "programming/frontend/angular.md", "versión gestionada dos");

    syncOpenCodeSkills(source, paths, false);

    expect(fs.readFileSync(publishedSkill(paths, "programming-frontend-angular"), "utf8"))
      .toContain("versión gestionada dos");
    expect(fs.readFileSync(foreign, "utf8")).toBe(foreignContent);
  });

  test("preserva intacta una colisión de ID que no está acreditada por el manifiesto", async () => {
    const { openCodeSkillsProblems, syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const source = fixtureCatalog(root, { "quality/testing.md": "Testing gestionado" });
    const collision = publishedSkill(paths, "git-commit-text");
    const foreignContent = "---\nname: git-commit-text\ndescription: Skill personalizada con ID reservado\n---\n\n# personalizada\n";
    write(collision, foreignContent);
    write(path.join(path.dirname(collision), "notas.md"), "dato de la persona\n");

    syncOpenCodeSkills(source, paths, false);

    expect(fs.readFileSync(collision, "utf8")).toBe(foreignContent);
    expect(fs.readFileSync(path.join(path.dirname(collision), "notas.md"), "utf8")).toBe("dato de la persona\n");
    expect(fs.existsSync(publishedSkill(paths, "quality-testing"))).toBe(true);
    expect(openCodeSkillsProblems(source, paths).join("\n")).toMatch(/git-commit-text/i);
  });

  test("poda solo una skill obsoleta cuyo hash sigue acreditado", async () => {
    const { syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const source = fixtureCatalog(root, {
      "stale.md": "Obsoleta sin cambios locales",
      "customized.md": "Gestionada antes de personalizarse",
    });

    syncOpenCodeSkills(source, paths, false);
    const customized = publishedSkill(paths, "customized");
    fs.appendFileSync(customized, "\nCambio local que Malahor no posee.\n", "utf8");
    fs.unlinkSync(path.join(source, "stale.md"));
    fs.unlinkSync(path.join(source, "customized.md"));

    syncOpenCodeSkills(source, paths, false);

    expect(fs.existsSync(path.join(skillsDir(paths), "stale"))).toBe(false);
    expect(fs.readFileSync(customized, "utf8")).toContain("Cambio local que Malahor no posee");
    expect(fs.existsSync(publishedSkill(paths, "git-commit-text"))).toBe(true);
  });

  test("dry-run informa sin crear, actualizar, podar ni reescribir el manifiesto", async () => {
    const { syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const source = fixtureCatalog(root, { "old.md": "Versión inicial" });

    syncOpenCodeSkills(source, paths, false);
    const before = snapshot(skillsDir(paths));
    fs.unlinkSync(path.join(source, "old.md"));
    sourceSkill(source, "new.md", "Versión nueva");
    sourceSkill(source, "git-commit-text.md", "Contenido canónico actualizado");

    syncOpenCodeSkills(source, paths, true);

    expect(snapshot(skillsDir(paths))).toBe(before);
    expect(fs.existsSync(publishedSkill(paths, "new"))).toBe(false);
    expect(fs.existsSync(publishedSkill(paths, "old"))).toBe(true);
  });

  test("uninstall retira solo SKILL.md acreditados y conserva modificaciones, colisiones y adjuntos", async () => {
    const { removeOpenCodeSkills, syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const source = fixtureCatalog(root, { "managed.md": "Skill que luego se personaliza" });

    syncOpenCodeSkills(source, paths, false);
    const canonical = publishedSkill(paths, "git-commit-text");
    const customized = publishedSkill(paths, "managed");
    fs.appendFileSync(customized, "\nCambio local.\n", "utf8");
    write(path.join(path.dirname(canonical), "notas.md"), "adjunto local\n");
    const foreign = publishedSkill(paths, "foreign");
    write(foreign, "---\nname: foreign\ndescription: Propia\n---\n\n# foreign\n");

    const beforeDryRun = snapshot(skillsDir(paths));
    removeOpenCodeSkills(paths, true);
    expect(snapshot(skillsDir(paths))).toBe(beforeDryRun);

    removeOpenCodeSkills(paths, false);

    expect(fs.existsSync(canonical)).toBe(false);
    expect(fs.readFileSync(path.join(path.dirname(canonical), "notas.md"), "utf8")).toBe("adjunto local\n");
    expect(fs.readFileSync(customized, "utf8")).toContain("Cambio local");
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(path.join(skillsDir(paths), MANIFEST_FILE))).toBe(false);
  });

  test("valida el catálogo completo antes de escribir: exige git-commit-text y IDs sin colisiones", async () => {
    const { syncOpenCodeSkills } = await loadSkillsModule();
    const root = scratch();
    const paths = pathsFor(root);
    const missingCanonical = path.join(root, "missing-canonical");
    sourceSkill(missingCanonical, "other.md", "Otra skill");

    expect(() => syncOpenCodeSkills(missingCanonical, paths, false)).toThrow(/git-commit-text/i);
    expect(fs.existsSync(skillsDir(paths))).toBe(false);

    const collision = fixtureCatalog(root, {
      "alpha-beta.md": "Primera ruta",
      "alpha/beta.md": "Segunda ruta",
    });
    expect(() => syncOpenCodeSkills(collision, paths, false)).toThrow(/colisi|alpha-beta/i);
    expect(fs.existsSync(skillsDir(paths))).toBe(false);
  });
});
