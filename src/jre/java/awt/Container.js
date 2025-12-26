// java.awt.Container - Base class for AWT containers

const ensureAwtElement = (obj) => {
  if (typeof document === 'undefined') return null;
  if (!obj._awtElement) {
    const element = document.createElement('div');
    element.style.position = 'relative';
    element.style.boxSizing = 'border-box';
    obj._awtElement = element;
  }
  return obj._awtElement;
};

const getComponentElement = (component) => {
  if (!component) return null;
  return component._awtElement || component._canvasElement || (component._awtComponent && component._awtComponent.canvasElement) || null;
};

const normalizeConstraint = (constraint) => {
  if (!constraint) return null;
  if (typeof constraint === 'string') return constraint;
  if (constraint.value) return constraint.value;
  if (constraint.toString) return constraint.toString();
  return null;
};

const applyLayout = (obj) => {
  if (typeof document === 'undefined') return;
  const containerEl = ensureAwtElement(obj);
  if (!containerEl) return;

  const layout = obj._layout;
  if (!layout || !layout.type) {
    containerEl.style.display = 'block';
    return;
  }

  if (layout.type === 'java/awt/BorderLayout') {
    containerEl.style.display = 'grid';
    containerEl.style.gridTemplateRows = 'auto 1fr auto';
    containerEl.style.gridTemplateColumns = 'auto 1fr auto';
    containerEl.style.alignItems = 'stretch';
    containerEl.style.justifyItems = 'stretch';
    containerEl.style.gap = `${layout._vgap || 0}px ${layout._hgap || 0}px`;

    const regions = new Map();
    if (obj._components) {
      for (const component of obj._components) {
        const region = normalizeConstraint(component._layoutConstraint) || 'Center';
        regions.set(region.toLowerCase(), component);
      }
    }

    if (!regions.has('center') && obj._canvasElement) {
      regions.set('center', { _awtElement: obj._canvasElement });
    }

    const place = (component, row, col, rowSpan, colSpan) => {
      const el = getComponentElement(component);
      if (!el) return;
      if (!containerEl.contains(el)) {
        containerEl.appendChild(el);
      }
      el.style.gridRow = rowSpan ? `${row} / span ${rowSpan}` : `${row}`;
      el.style.gridColumn = colSpan ? `${col} / span ${colSpan}` : `${col}`;
      el.style.alignSelf = 'stretch';
      el.style.justifySelf = 'stretch';
    };

    place(regions.get('north'), 1, 1, 1, 3);
    place(regions.get('south'), 3, 1, 1, 3);
    place(regions.get('west'), 2, 1, 1, 1);
    place(regions.get('center'), 2, 2, 1, 1);
    place(regions.get('east'), 2, 3, 1, 1);
    return;
  }

  if (layout.type === 'java/awt/FlowLayout') {
    containerEl.style.display = 'flex';
    containerEl.style.flexDirection = 'row';
    containerEl.style.flexWrap = 'wrap';
    containerEl.style.alignItems = 'center';
    const hgap = layout._hgap || 0;
    const vgap = layout._vgap || 0;
    containerEl.style.gap = `${vgap}px ${hgap}px`;

    if (layout._align === 0) {
      containerEl.style.justifyContent = 'flex-start';
    } else if (layout._align === 2) {
      containerEl.style.justifyContent = 'flex-end';
    } else {
      containerEl.style.justifyContent = 'center';
    }
  }
};

const addComponent = (obj, component) => {
  if (!component) return component;
  obj._components = obj._components || [];
  obj._components.push(component);
  component._parent = obj;
  const containerEl = ensureAwtElement(obj);
  const componentEl = getComponentElement(component);
  if (containerEl && componentEl && !containerEl.contains(componentEl)) {
    containerEl.appendChild(componentEl);
  }
  applyLayout(obj);
  return component;
};

module.exports = {
  super: 'java/awt/Component',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize as a component
      obj._components = [];
      obj._visible = true;
      obj._layout = null;
    },
    
    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      return addComponent(obj, component);
    },

    'add(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const component = args[0];
      const constraint = args[1];
      if (component) {
        component._layoutConstraint = normalizeConstraint(constraint);
      }
      addComponent(obj, component);
    },

    'add(Ljava/awt/Component;Ljava/lang/Object;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      const constraint = args[1];
      if (component) {
        component._layoutConstraint = normalizeConstraint(constraint);
      }
      return addComponent(obj, component);
    },
    
    'remove(Ljava/awt/Component;)V': (jvm, obj, args) => {
      const component = args[0];
      if (component && obj._components) {
        const index = obj._components.indexOf(component);
        if (index !== -1) {
          obj._components.splice(index, 1);
          component._parent = null;
          const componentEl = getComponentElement(component);
          if (componentEl && componentEl.parentNode) {
            componentEl.parentNode.removeChild(componentEl);
          }
        }
      }
    },

    'setLayout(Ljava/awt/LayoutManager;)V': (jvm, obj, args) => {
      obj._layout = args[0];
      applyLayout(obj);
    },

    'doLayout()V': (jvm, obj, args) => {
      applyLayout(obj);
    },
    
    'getComponentCount()I': (jvm, obj, args) => {
      return obj._components ? obj._components.length : 0;
    },
    
    'getComponent(I)Ljava/awt/Component;': (jvm, obj, args) => {
      const index = args[0];
      if (obj._components && index >= 0 && index < obj._components.length) {
        return obj._components[index];
      }
      return null;
    }
  },
};
