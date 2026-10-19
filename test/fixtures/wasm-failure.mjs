import { warmGenericGrammars, swapGrammarForTest } from '../../dist/graph/generic.js';
await warmGenericGrammars(['c_sharp']);
const entry = swapGrammarForTest('c_sharp', null);
swapGrammarForTest('c_sharp', { ...entry, parser: {
    parse() { throw new Error('fixture parse failure'); },
    reset() {},
} });
