// note: this version works pretty well with variables
// but it has problems with how they are gathered
// and switching the stack does not work either...


"use babel";

/*

select stack
  > -stack-select-frame <num>
  actually deprecated -> replaced by passing "--frame <num>" to each call...

*/

/*

{
	// path: "myShop.public" // resembles from the hierarchy
	name: "public"
	loaded: false         // numchild == "0"?
	children: null
}

*/


// TODO: add the token back to the executeAndWait (useful for the variables?)


import { spawn, exec } from "child_process";
import * as path from "path";
import { store, getBreakpoint, getBreakpoints } from "./store";

let process;
let isRunning = false;
let registeredVariables;

export function runTests(file) {
	return run(file);
}

export function runPackage(file) {
	return run(file);
}

function addOutputMessage(messageType, message, args) {
	store.dispatch({ type: "ADD_OUTPUT_MESSAGE", messageType, message, args });
}

function run(file) {
	if (process) {
		return;
	}

	registeredVariables = {};

	// TODO: the rebuild is not necessary here!
	const cwd = path.dirname(file);
	const outFile = "out";
	exec(`g++ -g ${file} -o ${outFile}`, { cwd }, (error, stdout, stderr) => {
		if (error) {
			console.error(error, stdout.toString(), stderr.toString());
			return;
		}

		addOutputMessage("gdb-debug", `Starting gdb with "${file}"`);

		isRunning = false;
		process = spawn("gdb", [outFile, "--interpreter=mi2"], { cwd });

		wait().then(() => {
			store.dispatch({ type: "SET_STATE", state: "started" });

			getBreakpoints().forEach((bp) => {
				addBreakpoint(bp.file, bp.line);
			});
		});

		process.stderr.on("data", (chunk) => {
			console.error(">>>>", chunk.toString());
		});

		process.on("close", (code) => {
			console.log(">>>>", "gdb closed with code", code);
			stop();
		});
		process.on("error", (err) => {
			console.error(">>>>", "gdb error", err);
			stop();
		});
	});
}

export function stop() {
	if (process) {
		process.kill();
	}
	process = null;

	store.dispatch({ type: "STOP" });
}

export function addBreakpoint(file, line) {
	if (!isStarted()) {
		store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, state: "notStarted" } });
		return Promise.resolve();
	}

	const bp = getBreakpoint(file, line);
	if (bp && bp.state === "busy") {
		return Promise.resolve();
	}

	// note: gdb requires 1 indexed line numbers whereas atom has 0 indexed
	const fileAndLine = `${file}:${line + 1}`;
	addOutputMessage("gdb-debug", `Adding breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line } });
	return _addBreakpoint(file, line + 1).then((bp) => {
		if (bp) {
			addOutputMessage("gdb-debug", `Added breakpoint: ${fileAndLine}`);
			store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, id: bp.number, state: "valid" } });
		}
	});
}
function _addBreakpoint(file, line) {
	return executeAndWait(`-break-insert ${line}`).then((results) => {
		let bp;
		results.forEach((result) => {
			if (result.type === "done" && result.value.bkpt) {
				bp = result.value.bkpt;
			}
		});
		return bp;
	});
}

export function removeBreakpoint(file, line) {
	const bp = getBreakpoint(file, line);
	if (!bp) {
		return Promise.resolve();
	}

	function done() {
		store.dispatch({ type: "REMOVE_BREAKPOINT", bp: { file, line, state: "removed" } });
	}

	if (bp.state === "invalid" || !isStarted()) {
		return Promise.resolve().then(done);
	}

	const fileAndLine = `${file}:${line + 1}`;
	addOutputMessage("gdb-debug", `Removing breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "REMOVE_BREAKPOINT", bp: { file, line, state: "busy" } });
	return _removeBreakpoint(bp.id)
		.then((success) => {
			if (success) {
				addOutputMessage("gdb-debug", `Removed breakpoint: ${fileAndLine}`);
				done();
			}
		});
}

function _removeBreakpoint(id) {
	return executeAndWait(`-break-delete ${id}`);
}

export function toggleBreakpoint(file, line) {
	const bp = getBreakpoint(file, line);
	if (!bp) {
		return addBreakpoint(file, line);
	}
	return removeBreakpoint(file, line);
}

export function updateBreakpointLine(file, line, newLine) {
	const bp = getBreakpoint(file, line);
	if (!isStarted()) {
		// just update the breakpoint in the store
		store.dispatch({ type: "UPDATE_BREAKPOINT_LINE", bp, newLine });
		return;
	}

	// remove and add the breakpoint, this also updates the store correctly
	_removeBreakpoint(bp.id).then(() => _addBreakpoint(file, newLine));
}

export function continue_() {
	if (!isRunning) {
		// we have to run the program first
		isRunning = true;
		return command("-exec-run");
	}

	// continue until the next breakpoint is hit
	return command("-exec-continue");
}
export function next() {
	// continue to the next line
	return command("-exec-next");
}
export function stepIn() {
	// continue to the next line AND step into functions
	return command("-exec-step");
}
export function stepOut() {
	return command("-exec-finish");
}

// command executes the given command (like continue, step, next, ...)
function command(cmd) {
	store.dispatch({ type: "SET_STATE", state: "busy" });

	const done = (results) => {
		if (results[results.length-1].type === "running") {
			// still running - continue waiting
			return wait().then(done);
		}
		/* if (newState.exited) {
			stop();
			return;
		} */

		store.dispatch({ type: "SET_STATE", state: "waiting" });

		return selectStacktrace(0).then(getStacktrace);
	};
	return executeAndWait(cmd).then(done);
}

// restart the gdb session
export function restart() {
	throw "'restart' not implemented";
	/* if (!isStarted()) {
		return;
	}
	executeAndWait("r", "Start it from the beginning? (y or n)").then(() => {
		executeAndWait("y").then(() => store.dispatch({ type: "RESTART" }));
	}); */
}

function pathJoin(...items) {
	return items.filter((i) => i).join(".");
}

function createVariable(v) {
	const hasChildren = v.numchild !== "0";
	return {
		name: v.exp || v.name,
		loaded: hasChildren === false ? true : false, // TODO ???
		hasChildren,
		value: hasChildren ? v.type : v.value,
		_orig: v
	};
}

function getVariables(cmd, prop) {
	return executeAndWait(cmd + " --simple-values").then((results) => {
		return results.reduce((o, r) => {
			if (!o && r.type === "done" && r.value[prop]) {
				return r.value[prop];
			}
			return o;
		}, null);
	});
}

function registerVariables() {
	// TODO: frame? thread?
	// get the variables for the current stack and

	/* return getVariables("-stack-list-locals", "locals").then((locals) => {
		return getVariables("-stack-list-arguments", "args").then((args) => {
			return (locals || []).concat(args || []);
		});
	}) */
	return getVariables("-stack-list-variables", "variables")
		.then((vars) => {
			// get the existing variables
			const { stacktrace, selectedStacktrace } = store.getState().gdb;
			const existingVariables = stacktrace[selectedStacktrace] && stacktrace[selectedStacktrace].variables || {};

			const variables = {};
			const process = () => {
				const v = vars.shift();
				if (!v) {
					return Promise.resolve(variables); // done
				}
				if (registeredVariables[v.name]) {
					// only update the type and value
					return updateVariable(v.name, existingVariables)
						.then((updated) => {
							Object.assign(variables, updated);
						})
						.then(process);
				}

				// register a new variable
				const frame = "@"; // TODO: @ = frame? see http://gdb.sourceware.narkive.com/2dXFnOyc/gdb-mi-var-update-create-bug
				return executeAndWait(`-var-create ${v.name} ${frame} ${v.name}`).then((results) => {
					results.forEach(({ type, value }) => {
						if (type === "done") {
							registeredVariables[value.name] = true;
							variables[value.name] = createVariable(value);
						}
					});
				}).then(process);
			};
			return process();
		})
		.then((variables) => {
			store.dispatch({
				type: "UPDATE_VARIABLES",
				index: store.getState().gdb.selectedStacktrace,
				variables
			});
		});
}

function updateVariable(path, existingVariables) {
	return executeAndWait(`-var-update --simple-values ${path}`).then((results) => {
		const variables = {
			// copy the existing variable
			[path]: Object.assign({}, existingVariables[path])
		};
		results.forEach(({ type, value }) => {
			if (type === "done") {
				const changelist = value.changelist;
				changelist.forEach((ch) => {
					const existingVariable = existingVariables[ch.name];
					let newVariable = {};
					if (ch.type_changed === "false") {
						// no type change -> update the value
						newVariable = {
							value: ch.value
						};
					} else {
						// type has changed! create a "new variable"
						const hasChildren =  ch.new_num_children !== "0";
						newVariable = {
							name: ch.name.split(".").pop(),
							loaded: hasChildren === false ? true : false, // TODO ???
							hasChildren,
							value: hasChildren ? ch.new_type : ch.value,
							_orig: ch
						};
					}
					variables[ch.name] = Object.assign({}, existingVariable, newVariable);
				});
			}
		});
		return variables;
	});
}

/* function unregisterVariables() {
	const { stacktrace, selectedStacktrace } = store.getState().gdb;
	if (!stacktrace[selectedStacktrace] || !stacktrace[selectedStacktrace].variables) {
		return Promise.resolve();
	}

	const { variables } = stacktrace[selectedStacktrace];
	const paths = Object.keys(variables).filter((p) => p.indexOf(".") === -1);
	const process = () => {
		const path = paths.pop();
		if (!path) {
			return Promise.resolve();
		}
		return executeAndWait(`-var-delete ${variables[path].name}`).then((results) => {
			if (results[0].type !== "done") {
				console.log(path, results);
			}
		}).then(process);
	};
	return process();
} */

export function loadVariable(path, variable) {
	void variable;
	return executeAndWait(`-var-list-children --simple-values ${path}`).then((results) => {
		const variables = {};
		results.forEach(({ type, value }) => {
			if (type !== "done") {
				return;
			}
			value.children.forEach((v) => {
				const p = pathJoin(path, v.exp);
				if (variables[p]) {
					debugger;
				}
				variables[p] = createVariable(v);
			});
		}, null);
		store.dispatch({
			// TODO: pass on which variable has been loaded (always parent path?)
			type: "UPDATE_VARIABLES",
			variables,
			index: store.getState().gdb.selectedStacktrace
		});
	});
}

function getStacktrace() {
	if (!isStarted()) {
		return Promise.resolve([]);
	}
	return executeAndWait("-stack-list-frames").then((results) => {
		let stacktrace;
		results.forEach((r) => {
			if (r.type === "done" && r.value.stack) {
				stacktrace = r.value.stack.map((st) => {
					return {
						file: path.normalize(st.file),
						line: +st.line,
						func: st.func,
						addr: st.addr // TODO: id?
					};
				});
			}
		});
		// delete all existing variables in gdb
		// return unregisterVariables().then(() => {
		if (stacktrace) {
			// TODO: copy the variables if the stacktrace matches (using addr/id?)
			// TODO: update the stacktrace AFTER the variables? and apply the variables immediately?
			store.dispatch({ type: "UPDATE_STACKTRACE", stacktrace });
			registerVariables();

			return stacktrace;
		}
		return [];
		// });
	});
}

export function selectStacktrace(index) {
	if (!isStarted()) {
		return Promise.resolve();
	}
	if (store.getState().gdb.selectedStacktrace !== index) {
		// no need to change
		store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "waiting", index });
	}
	return Promise.resolve();

	// is this even needed? I don't think so...
	// return getStacktrace();

	/* it seems that it is deprecated to select a stack frame, but pass it to each call using --frame (and --thread)
	store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "busy", index });
	return executeAndWait(`frame ${index}`).then((output) => {
		store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "waiting", index });
		getStacktrace();
	}); */
}

// TODO: thread management!

export function isStarted() {
	const state = store.getState().gdb.state;
	return state !== "notStarted" && state !== "starting";
}

function wait(waitFor = "(gdb) \r\n") {
	return new Promise(function(resolve) {
		let output = "";
		const fn = (chunk) => {
			const txt = chunk.toString();
			output += txt;
			if (txt.endsWith(waitFor)) {
				const lines = output.split("\n");
				const results = lines.slice(0, lines.length-2).map(parseLine);
				resolve(results);
			} else {
				process.stdout.once("data", fn);
			}
		};
		process.stdout.once("data", fn);
		// process.stderr.once("data", fn);
	});
}
function executeAndWait(cmd, waitFor) {
	const p = wait(waitFor);
	process.stdin.write(cmd + "\n");
	return p;
}

// parseOutput parses the JSON like structured output of GDB
// unfortunately it is only JSON *like* ...
function parseOutput(text, o) {
	let isKey = true;
	let isRawValue = false;
	let key = "";
	let value = "";

	function add() {
		if (Array.isArray(o)) {
			o.push(value);
		} else if (key) {
			o[key] = value;
		}
		isKey = !isKey;
		value = "";
		key = "";
	}

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		// TODO: handle escaped \" !
		if (char === "\"") {
			isRawValue = !isRawValue;
			if (!isRawValue) {
				add();
			}
			continue;
		}

		if (isRawValue) {
			value += char;
			continue;
		}

		if (char === "=") {
			isKey = false;
			continue;
		} else if (char === "{") {
			value = {};
			i += parseOutput(text.substr(i+1), value);
			add();
			continue;
		} else if (char === "[") {
			value = [];
			i += parseOutput(text.substr(i+1), value);
			add();
			continue;
		} else if (char === "]" || char === "}") {
			return i+1;
		} else if (char === ",") {
			continue;
		}

		if (isKey) {
			key += char;
		}
	}
	return "";
}

const regLogStatement = /^~\"(.*)\n\"$/g;
function parseLine(line) {
	switch (line[0]) {
		case "~":
			// simple log statement
			var matches = regLogStatement.exec(line);
			console.log(matches && matches[1] || line);
			return undefined;
		// TODO: catch unprefixed lines (lines without a ~*= or so)
		//       they are most likely an stdout message...
		default:
			// output values
			// e.g. =breakpoint-created,bkpt={number="2",type="breakpoint",disp="keep"}
			var index = line.indexOf(",");
			var type = line.slice(1, index);
			var value = {};
			parseOutput(line.slice(index + 1), value);
			return { type, value };
	}
}
