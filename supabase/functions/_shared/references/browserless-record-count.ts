// Hosted Edge cannot Deno.readTextFile sibling assets; import the JS source as text instead.
import source from "./browserless-record-count.js" with { type: "text" };
export default source;
