import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function valueExports(path) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
        path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const exports = new Map();
    function binding(name, value) {
        if (ts.isIdentifier(name)) exports.set(name.text, value);
        else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
            for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
    }
    for (const node of source.statements) {
        if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause))
            for (const entry of node.exportClause.elements) if (!entry.isTypeOnly) exports.set(entry.name.text, undefined);
        if (ts.isExportAssignment(node)) exports.set('default', undefined);
        if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                const value = declaration.initializer ?? (declaration.type && ts.isLiteralTypeNode(declaration.type) ? declaration.type.literal : undefined);
                binding(declaration.name, value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) ? value.text : undefined);
            }
        } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name)
            exports.set(node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : node.name.text, undefined);
    }
    return exports;
}

test('shipped JavaScript and declaration sources have no syntax errors', () => {
    const diagnostics = [];
    for (const path of files(root).filter(path => /(?:\.js|\.d\.ts)$/.test(path))) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
            path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
        for (const diagnostic of source.parseDiagnostics)
            diagnostics.push(`${relative(root, path)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    assert.deepEqual(diagnostics, []);
});

test('maintained declarations match runtime value exports and literal constants', () => {
    const drift = [];
    for (const declaration of files(root).filter(path => path.endsWith('.d.ts'))) {
        const js = declaration.replace(/\.d\.ts$/, '.js');
        if (!existsSync(js)) continue; // Type-only schema modules need no runtime file.
        const actual = valueExports(js), declared = valueExports(declaration);
        for (const name of new Set([...actual.keys(), ...declared.keys()])) {
            if (!actual.has(name) || !declared.has(name))
                drift.push(`${relative(root, declaration)}: ${name} ${actual.has(name) ? 'missing declaration' : 'missing runtime export'}`);
            else if (actual.get(name) !== undefined && declared.get(name) !== undefined && actual.get(name) !== declared.get(name))
                drift.push(`${relative(root, declaration)}: ${name} literal ${declared.get(name)} != ${actual.get(name)}`);
        }
    }
    assert.deepEqual(drift, []);
});

test('shipped declarations type-check without missing modules', () => {
    const program = ts.createProgram(files(root).filter(path => path.endsWith('.d.ts')), {
        noEmit: true, strict: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: ['node'],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic =>
        `${diagnostic.file ? relative(root, diagnostic.file.fileName) + ': ' : ''}`
        + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    assert.deepEqual(diagnostics, []);
});
