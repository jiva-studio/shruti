export namespace domain {
	
	export class Device {
	    id: string;
	    name: string;
	    label: string;
	    kind: string;
	    default: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Device(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	        this.default = source["default"];
	    }
	}

}

