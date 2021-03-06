"use babel";

import { React, ReactDOM } from "react-for-atom";
import { connect } from "react-redux";
import { copyToClipboard } from "./utils";
import * as GDB from "./gdb";

class Variables extends React.Component {
	componentDidMount() {
		copyToClipboard(ReactDOM.findDOMNode(this));
	}
	render() {
		return <div onClick={this.onToggleClick.bind(this)}>
			<Children variables={this.props.variables} path={""} expanded={this.props.expanded} />
		</div>;
	}
	onToggleClick(ev) {
		const path = ev.target.dataset.path;
		if (!path) {
			return;
		}

		// update the store
		this.props.onToggle(path);

		// then load the variable if not done already
		const v = this.props.variables[path];
		if (v && !v.loaded) {
			GDB.loadVariable(path);
			return;
		}
	}
}

export default connect(
	(state) => {
		return {
			variables: (state.gdb.stacktrace[state.gdb.selectedStacktrace] || {}).variables,
			expanded: state.variables.expanded
		};
	},
	(dispatch) => {
		return {
			onToggle: (path) => {
				dispatch({ type: "TOGGLE_VARIABLE", path });
			}
		};
	}
)(Variables);

const Variable = (props) => {
	const { variables, path, expanded } = props;
	const variable = variables[path];

	const name = renderValue(variable.name);
	const isExpanded = variable.hasChildren && expanded[path];
	let toggleClassName = "gdb-debug-toggle" + (!variable.hasChildren ? " gdb-debug-toggle-hidden": "");
	toggleClassName += " icon icon-chevron-" + (isExpanded ? "down" : "right");
	return <li>
		<span className={toggleClassName} data-path={path} />
		{variable.value ? <span tabIndex={-1}>{name}: {renderValue(variable.value)}</span> : <span>{name}</span>}
		{isExpanded ? <Children variables={variables} path={path} expanded={expanded} /> : null}
	</li>;
};

const Children = (props) => {
	const { variables, path, expanded } = props;
	const children = Object.keys(variables || {}).filter((p) => parentPath(p) === path).sort();
	if (!children.length) {
		return <div />;
	}
	const vars = children.map((p, i) => {
		return <Variable key={i} path={p} variables={variables} expanded={expanded} />;
	});
	return <ol>{vars}</ol>;
};

function renderValue(value) {
	if (Array.isArray(value)) {
		return value.map((v, i) => <span key={i}>{renderValue(v)}</span>);
	}
	if (typeof value === "object" && "value" in value) {
		const v = renderValue(value.value);
		return value.className ? <span className={value.className}>{v}</span> : v;
	}
	return (value === undefined || value === null) ? "" : value;
}

function parentPath(p) {
	return p.split(".").slice(0,-1).join(".");
}
