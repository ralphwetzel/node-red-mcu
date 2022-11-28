/*
 * Copyright (c) 2022  Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK Runtime.
 *
 *   The Moddable SDK Runtime is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   The Moddable SDK Runtime is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Lesser General Public License for more details.
 *
 *   You should have received a copy of the GNU Lesser General Public License
 *   along with the Moddable SDK Runtime.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

import {Node, configFlowID} from "nodered";
import Timer from "timer";
import WebSocket from "WebSocket";
import Modules from "modules";

const connected = Object.freeze({
	fill: "green",
	shape: "dot",
	text: "connected ",
	event: "connect"
});

const disconnected = Object.freeze({
	fill: "red",
	shape: "ring",
	text: "common.status.disconnected",
	event: "disconnect"
});

class WebSocketClient extends Node {
	#ws;
	#reconnect;
	#options;
	#nodes;

	onStart(config) {
		if (config.tls || ("0" !== config.hb))
			throw new Error("unimplemented");		

		this.#options = {
			path: config.path,
			wholemsg: "true" === config.wholemsg,
			subprotocol: config.subprotocol
		};

		this.status(disconnected);
		this.#connect();
	}
	onMessage(msg) {
		if (1 !== this.#ws?.readyState)
			return;

		if (this.#options.wholemsg)
			this.#ws.send(JSON.stringify(msg));
		else
			this.#ws.send(msg.payload);
	}
	#connect() {
		const options = this.#options;
		this.#ws = options.subprotocol ? new WebSocket(options.path, options.subprotocol) : new WebSocket(options.path);
		this.#ws.binaryType = "arraybuffer"; 
		this.#ws.addEventListener("open", event => {
			Timer.clear(this.#reconnect);
			this.#reconnect = undefined;
			this.status(connected);
		});
		this.#ws.addEventListener("message", event => {
			let msg = event.data;
			if (this.#options.wholemsg)
				msg = JSON.parse(msg);
			else
				msg = {payload: msg};

			for (let node of this.#nodes)
				node.send(msg);
		});
		const close = event => {
			this.#ws = undefined;
			this.status(disconnected);

			this.#reconnect ??= Timer.repeat(() => {
				if (this.#ws)
					return;
				
				this.#connect();
			}, 5_000);
		}
		this.#ws.addEventListener("close", close);
		this.#ws.addEventListener("error", close);
	}
	add(node) {
		this.#nodes ??= new Set;
		this.#nodes.add(node);
	}
	status(status) {
		const nodes = this.#nodes;
		if (!nodes) return;
		for (let node of nodes)
			node.status(status);
	}

	static type = "websocket-client";
	static {
		RED.nodes.registerType(this.type, this);
	}
}

class WebSocketListener extends Node {
	#wholemsg;
	#connections = new Map;		// remote connections to this listener
	#nodes;		// "websocket in" nodes using this listener

	onStart(config) {
		this.#wholemsg = "true" === config.wholemsg;

		const Server = Modules.importNow("httpserver");		// dynamic import so dependency on http server only if websocket listener is used 
		const WebSocketHandshake = Modules.importNow("embedded:network/http/server/options/websocket");

		Server.add("GET", config.path, this, {
			...WebSocketHandshake,
			listener: this,
			onDone() {
				const listener = this.route.listener;
				const ws = new WebSocket(this.detach());
				ws._session = RED.util.generateId();
				listener.#connections.set(ws._session, ws);
				ws.addEventListener("message", function(event) {
					let msg = event.data;
					if (listener.#wholemsg)
						msg = JSON.parse(msg);
					else
						msg = {payload: msg};
					msg._session = {type: "websocket", id: ws._session};

					for (let node of listener.#nodes)
						node.send(msg);
				});
				const remove = function() {
					listener.#connections.delete(ws._session);
				}
				ws.addEventListener("close", remove);
				ws.addEventListener("error", remove);
			}
		});
	}
	onMessage(msg, done) {
		const _session = msg._session;
		delete msg._session;
		const payload = this.#wholemsg ? JSON.stringify(msg) : (Buffer.isBuffer(msg.payload) ? msg.payload : RED.util.ensureString(msg.payload));  
		if ("websocket" === _session?.type) {
			const connection = this.#connections.get(_session.id);
			if (connection)
				connection.send(payload);
			else
				this.warn("websocket session not found")
		}
		else {
			for (const [id, connection] of this.#connections)
				connection.send(payload);
		}
		done();
	}
	add(node) {
		this.#nodes ??= new Set;
		this.#nodes.add(node);
	}

	static type = "websocket-listener";
	static {
		RED.nodes.registerType(this.type, this);
	}
}

class WebSocketIn extends Node {
	onStart(config) {
		super.onStart(config);

		const ws = flows.get(configFlowID).getNode(config.client || config.server);
		ws?.add(this);
	}

	static type = "websocket in";
	static {
		RED.nodes.registerType(this.type, this);
	}
}

class WebSocketOut extends Node {
	#ws;

	onStart(config) {
		super.onStart(config);

		this.#ws = flows.get(configFlowID).getNode(config.client || config.server);
	}
	onMessage(msg, done) {
		return this.#ws.onMessage(msg, done);		// maybe unnecessary to use RED.mcu.enqueue here
	}

	static type = "websocket out";
	static {
		RED.nodes.registerType(this.type, this);
	}
}
