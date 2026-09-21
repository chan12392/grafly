// Fixed contract matrix, not a sample of real user intents. Labels are supplied
// separately from inputs and never passed to the circuit.
export function circuitAccuracyCases() {
    const cases = [];
    for (let i = 0; i < 20; i++) {
        const name = `work${i}`;
        for (const family of ['degree_only', 'qualified_peer', 'three_peers',
            'equal_support', 'weak_gap', 'unique', 'source_vendor', 'source_test',
            'cwd_context', 'explicit_scope']) {
            const qualified = family === 'qualified_peer';
            const aPath = family === 'cwd_context' ? 'src/cache/a.js' : 'src/alpha/a.js';
            const bPath = family === 'source_vendor' ? 'node_modules/lib/b.js'
                : family === 'source_test' ? 'test/b.test.js' : 'src/beta/b.js';
            const node = (path) => ({ id: `${path}#${qualified ? 'Store.' : ''}${name}`,
                name, path, kind: qualified ? 'method' : 'function', span: 'L1-L1' });
            const a = node(aPath), b = node(bPath);
            const nodes = family === 'unique' ? [a] : [a, b];
            if (family === 'three_peers') nodes.push(node('src/gamma/c.js'));
            const edges = [];
            const degree = ['degree_only', 'qualified_peer', 'three_peers'].includes(family)
                ? 24 + i : family === 'weak_gap' ? 1 : 0;
            for (let j = 0; j < degree; j++) {
                const caller = { id: `use${j}.js#caller`, name: `caller${j}`,
                    path: `use${j}.js`, kind: 'function', span: 'L1-L1' };
                nodes.push(caller);
                edges.push({ source: caller.id, target: a.id, relation: 'calls' });
            }
            // Alternate insertion order so a first-item policy cannot pass.
            if (i % 2) nodes.reverse();
            const ambiguous = ['degree_only', 'qualified_peer', 'three_peers',
                'equal_support', 'weak_gap'].includes(family);
            cases.push({ id: `${family}-${i}`, family,
                graph: { version: 1, nodes, edges, meta: {} },
                query: qualified ? `Store.${name}` : name,
                scope: family === 'explicit_scope' ? 'src/alpha' : null,
                cwd: family === 'cwd_context' ? ['cache'] : [],
                expected: { verdict: ambiguous ? 'abstain' : 'confident',
                    selected: ambiguous ? null : a.id } });
        }
    }
    return cases;
}
