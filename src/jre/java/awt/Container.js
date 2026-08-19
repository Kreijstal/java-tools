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

const matchesCard = (container, component, currentName) => {
  const cards = container._cards || {};
  for (const name of Object.keys(cards)) {
    if (cards[name] === component) return name === currentName;
  }
  // Components not registered as named cards fall back to their constraint
  return component._layoutConstraint === currentName;
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
    return;
  }

  if (layout.type === 'java/awt/GridLayout') {
    containerEl.style.display = 'grid';
    const configuredRows = layout._rows || 0;
    const configuredCols = layout._cols || 0;
    const hgap = layout._hgap || 0;
    const vgap = layout._vgap || 0;
    containerEl.style.gap = `${vgap}px ${hgap}px`;
    const componentEls = (obj._components || [])
      .map(getComponentElement)
      .filter(Boolean);
    const componentCount = componentEls.length;
    const rows = configuredRows > 0
      ? configuredRows
      : Math.max(1, Math.ceil(componentCount / configuredCols));
    const cols = configuredRows > 0
      ? Math.max(1, Math.ceil(componentCount / configuredRows))
      : configuredCols;
    containerEl.style.gridTemplateColumns =
      `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`;
    containerEl.style.gridTemplateRows =
      `repeat(${Math.max(1, rows)}, minmax(0, 1fr))`;
    containerEl.style.alignItems = 'stretch';
    containerEl.style.justifyItems = 'stretch';
    for (const el of componentEls) {
      if (!containerEl.contains(el)) containerEl.appendChild(el);
      el.style.gridRow = 'auto';
      el.style.gridColumn = 'auto';
      el.style.alignSelf = 'stretch';
      el.style.justifySelf = 'stretch';
    }
    return;
  }

  if (layout.type === 'java/awt/CardLayout') {
    containerEl.style.display = 'block';
    const current = obj._currentCard;
    const components = obj._components || [];
    for (const component of components) {
      const el = getComponentElement(component);
      if (!el) continue;
      if (!containerEl.contains(el)) containerEl.appendChild(el);
      const isActive = current == null || matchesCard(obj, component, current);
      el.style.display = isActive ? 'block' : 'none';
    }
    return;
  }
};

const registerLayoutComponent = (jvm, obj, component, constraint) => {
  const layout = obj._layout;
  if (!layout || !layout.type) return;
  const addWithObject = jvm._jreFindMethod(
    layout.type,
    'addLayoutComponent',
    '(Ljava/awt/Component;Ljava/lang/Object;)V',
  );
  if (addWithObject) {
    addWithObject(jvm, layout, [component, constraint]);
    return;
  }
  const addWithName = jvm._jreFindMethod(
    layout.type,
    'addLayoutComponent',
    '(Ljava/lang/String;Ljava/awt/Component;)V',
  );
  if (addWithName) addWithName(jvm, layout, [constraint, component]);
};

const addComponent = (jvm, obj, component, constraint = null) => {
  if (!component) return component;
  obj._components = obj._components || [];
  obj._components.push(component);
  component._parent = obj;
  registerLayoutComponent(jvm, obj, component, constraint);
  const containerEl = ensureAwtElement(obj);
  const componentEl = getComponentElement(component);
  if (containerEl && componentEl && !containerEl.contains(componentEl)) {
    containerEl.appendChild(componentEl);
  }
  applyLayout(obj);
  return component;
};

function makeDimension(width, height) {
  return {
    type: 'java/awt/Dimension',
    width,
    height,
    fields: {
      'java/awt/Dimension.width': width,
      'java/awt/Dimension.height': height,
    },
  };
}

function makeInsets(top, left, bottom, right) {
  return {
    type: 'java/awt/Insets',
    top,
    left,
    bottom,
    right,
    fields: {
      'java/awt/Insets.top': top,
      'java/awt/Insets.left': left,
      'java/awt/Insets.bottom': bottom,
      'java/awt/Insets.right': right,
    },
  };
}

module.exports = {
  super: 'java/awt/Component',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Initialize as a component
      obj._components = [];
      obj._visible = true;
      obj._layout = null;
    },

    'getSize()Ljava/awt/Dimension;': (jvm, obj, args) => {
      return makeDimension(obj._width || 0, obj._height || 0);
    },

    'getInsets()Ljava/awt/Insets;': (jvm, obj, args) => {
      return makeInsets(0, 0, 0, 0);
    },

    'size()Ljava/awt/Dimension;': (jvm, obj, args) => {
      return makeDimension(obj._width || 0, obj._height || 0);
    },

    'insets()Ljava/awt/Insets;': (jvm, obj, args) => {
      return makeInsets(0, 0, 0, 0);
    },
    
    'add(Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const component = args[0];
      return addComponent(jvm, obj, component);
    },

    // Legacy pre-1.1 API: add(String name, Component comp) — the name is the
    // layout constraint (used by CardLayout for card names, BorderLayout regions).
    'add(Ljava/lang/String;Ljava/awt/Component;)Ljava/awt/Component;': (jvm, obj, args) => {
      const name = args[0];
      const component = args[1];
      if (component) {
        component._layoutConstraint = normalizeConstraint(name);
      }
      return addComponent(jvm, obj, component, name);
    },

    'add(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const component = args[0];
      const constraint = args[1];
      if (component) {
        component._layoutConstraint = normalizeConstraint(constraint);
      }
      addComponent(jvm, obj, component, constraint);
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
