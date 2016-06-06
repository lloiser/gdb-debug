"use babel";

import { CompositeDisposable } from "atom";
import path from "path";
import { React, ReactDOM } from "react-for-atom";
import { Provider, connect } from "react-redux";

import Variables from "./variables.jsx";
import { elementPropInHierarcy } from "./utils";
import { store, getBreakpoints } from "./store";
import * as GDB from "./gdb";
import * as Commands from "./commands";

class Panel extends React.Component {
	constructor(props) {
		super(props);

		["onResizeStart", "onResize", "onResizeEnd", "onCommandClick", "onStacktraceClick",
			"onGoroutineClick", "onBreakpointClick", "onRemoveBreakpointClick"]
			.forEach((fn) => this[fn] = this[fn].bind(this));

		this.state = {
			expanded: {
				stacktrace: true,
				goroutines: true,
				variables: true,
				breakpoints: true
			}
		};
	}

	componentWillReceiveProps(np) {
		this.setState({ width: np.width });
	}

	render() {
		// TODO: add the busy overlay if state == "busy" || "starting"
		return <div className="gdb-debug-panel-root" style={{width: this.props.width}}>
			<div className="gdb-debug-panel-resizer" onMouseDown={this.onResizeStart} />
			{this.renderCommands()}
			{this.renderArgs()}
			<div className="gdb-debug-panel-content">
				{this.renderStacktrace()}
				{this.renderGoroutines()}
				{this.renderVariables()}
				{this.renderBreakpoints()}
			</div>
			<button type="button" onClick={this.props.onToggleOutput}
				className="btn gdb-debug-btn-flat gdb-debug-panel-showoutput">
				Toggle output panel
			</button>
		</div>;
	}

	renderCommands() {
		const layout = Commands.getPanelCommands();
		return <div className="gdb-debug-panel-commands">{layout.map(this.renderCommand, this)}</div>;
	}
	renderCommand(cmd) {
		return <button key={cmd.cmd} type="button" className="btn gdb-debug-btn-flat" title={cmd.title}
			data-cmd={cmd.cmd} onClick={this.onCommandClick}>
			{cmd.icon ? <span className={"icon-" + cmd.icon} /> : null}
			{cmd.text}
		</button>;
	}

	renderArgs() {
		return null;
		/* TODO: is this supported in GDB?
		return <div>
			<input className="gdb-debug-panel-args native-key-bindings" value={this.props.args}
				placeholder="arguments passed to gdb after --" onChange={this.props.onArgsChange} />
		</div>;
		*/
	}

	renderStacktrace() {
		const { selectedStacktrace } = this.props;
		const items = (this.props.stacktrace || []).map((st, index) => {
			const className = selectedStacktrace === index ? "selected" : null;
			const file = shortenPath(st.file);
			return <div key={index} className={className} data-index={index} onClick={this.onStacktraceClick}>
				<div>{st.func}</div>
				<div>@ {file}:{st.line}</div>
			</div>;
		});
		return this.renderExpandable("stacktrace", "Stacktrace", items);
	}

	renderGoroutines() {
		return null;
		/* TODO: threads!!!
		const { selectedGoroutine } = this.props;
		const items = (this.props.goroutines || []).map(({ id, userCurrentLoc }) => {
			const className = selectedGoroutine === id ? "selected" : null;
			const file = shortenPath(userCurrentLoc.file);
			const fn = userCurrentLoc.function.name.split("/").pop();
			return <div key={id} className={className} data-id={id} onClick={this.onGoroutineClick}>
				<div>{fn}</div>
				<div>@ {file}:{userCurrentLoc.line}</div>
			</div>;
		});
		return this.renderExpandable("goroutines", "Goroutines", items);
		*/
	}

	renderVariables() {
		return this.renderExpandable("variables", "Variables", <Variables />);
	}

	renderBreakpoints() {
		const items = this.props.breakpoints.map(({ file, line, state, message }) => {
			return <div key={file + "|" + line} data-file={file} data-line={line}
				title={message || ""} onClick={this.onBreakpointClick}>
				<span className="icon-x" onClick={this.onRemoveBreakpointClick} />
				<span className={"gdb-debug-breakpoint gdb-debug-breakpoint-state-" + state} />
				{shortenPath(file)}:{line+1}
			</div>;
		});
		return this.renderExpandable("breakpoints", "Breakpoints", items);
	}

	renderExpandable(name, text, content) {
		const expanded = this.state.expanded[name];
		return <div className="gdb-debug-expandable" data-expanded={expanded}>
			<div className="gdb-debug-expandable-header" onClick={this.onExpandChange.bind(this, name)}>
				<span className={"gdb-debug-toggle icon icon-chevron-" + (expanded ? "down" : "right")}></span>
				{text}
			</div>
			<div className={`gdb-debug-expandable-body gdb-debug-panel-${name}`}>{content}</div>
		</div>;
	}

	onResizeStart() {
		document.addEventListener("mousemove", this.onResize, false);
		document.addEventListener("mouseup", this.onResizeEnd, false);
		this.setState({ resizing: true });
	}
	onResize({ pageX }) {
		if (!this.state.resizing) {
			return;
		}
		const node = ReactDOM.findDOMNode(this).offsetParent;
		this.props.onUpdateWidth(node.getBoundingClientRect().width + node.offsetLeft - pageX);
	}
	onResizeEnd() {
		if (!this.state.resizing) {
			return;
		}
		document.removeEventListener("mousemove", this.onResize, false);
		document.removeEventListener("mouseup", this.onResizeEnd, false);
		this.setState({ resizing: false });
	}

	onExpandChange(name) {
		this.state.expanded[name] = !this.state.expanded[name];
		this.setState(this.state);
	}

	onCommandClick(ev) {
		const command = elementPropInHierarcy(ev.target, "dataset.cmd");
		if (!command) {
			return;
		}
		Commands.get(command).action();
	}

	onStacktraceClick(ev) {
		const index = elementPropInHierarcy(ev.target, "dataset.index");
		if (index) {
			GDB.selectStacktrace(+index);
		}
	}

	onGoroutineClick(ev) {
		const id = elementPropInHierarcy(ev.target, "dataset.id");
		if (id) {
			GDB.selectGoroutine(+id);
		}
	}

	onBreakpointClick(ev) {
		const file = elementPropInHierarcy(ev.target, "dataset.file");
		if (file) {
			const line = +elementPropInHierarcy(ev.target, "dataset.line");

			// check if the file even exists
			this.fileExists(file)
				.then(() => {
					atom.workspace.open(file, { initialLine: line, searchAllPanes: true }).then(() => {
						const editor = atom.workspace.getActiveTextEditor();
						editor.scrollToBufferPosition([line, 0], { center: true });
					});
				})
				.catch(() => this.removeBreakpoints(file));
		}
	}

	fileExists(file) {
		return Promise.all(
			atom.project.getDirectories().map(
				(dir) => dir.getFile(dir.relativize(file)).exists()
			)
		).then((results) => {
			if (results.indexOf(true) === 0) {
				return Promise.resolve();
			}
			return Promise.reject();
		});
	}

	removeBreakpoints(file) {
		const noti = atom.notifications.addWarning(
			`The file ${file} does not exist anymore.`,
			{
				dismissable: true,
				detail: "Remove all breakpoints for this file?",
				buttons: [{
					text: "Yes",
					onDidClick: () => {
						noti.dismiss();
						getBreakpoints(file).forEach((bp) => GDB.removeBreakpoint(file, bp.line));
					}
				}, {
					text: "No",
					onDidClick: () => noti.dismiss()
				}]
			});
	}

	onRemoveBreakpointClick(ev) {
		const file = elementPropInHierarcy(ev.target, "dataset.file");
		if (file) {
			const line = +elementPropInHierarcy(ev.target, "dataset.line");
			GDB.removeBreakpoint(file, line);
			ev.preventDefault();
			ev.stopPropagation();
		}
	}
}

const PanelListener = connect(
	(state) => {
		return {
			width: state.panel.width,
			state: state.gdb.state,
			args: state.gdb.args,
			stacktrace: state.gdb.stacktrace,
			goroutines: state.gdb.goroutines,
			breakpoints: state.gdb.breakpoints,
			selectedStacktrace: state.gdb.selectedStacktrace,
			selectedGoroutine: state.gdb.selectedGoroutine
		};
	},
	(dispatch) => {
		return {
			onUpdateWidth: (width) => {
				dispatch({ type: "SET_PANEL_WIDTH", width });
			},
			onToggleOutput: () => {
				dispatch({ type: "TOGGLE_OUTPUT" });
			},
			onArgsChange: (ev) => {
				dispatch({ type: "UPDATE_ARGS", args: ev.target.value });
			}
		};
	}
)(Panel);

let atomPanel;

function onStoreChange() {
	const panelState = store.getState().panel;
	if (panelState.visible !== atomPanel.isVisible()) {
		atomPanel[panelState.visible ? "show" : "hide"]();
	}
}

let subscriptions;
export default {
	init() {
		subscriptions = new CompositeDisposable(
			{ dispose: store.subscribe(onStoreChange) }
		);

		const item = document.createElement("div");
		item.className = "gdb-debug-panel";
		atomPanel = atom.workspace.addRightPanel({ item, visible: store.getState().panel.visible });

		ReactDOM.render(
			<Provider store={store}>
				<PanelListener />
			</Provider>,
			item
		);
	},
	dispose() {
		subscriptions.dispose();
		subscriptions = null;

		ReactDOM.unmountComponentAtNode(atomPanel.getItem());

		atomPanel.destroy();
		atomPanel = null;
	}
};

function shortenPath(file) {
	return path.normalize(file).split(path.sep).slice(-2).join(path.sep);
}
