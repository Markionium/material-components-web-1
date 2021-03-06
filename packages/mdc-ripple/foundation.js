/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {MDCFoundation} from '@material/base';

import {getCorrectEventName} from '@material/animation';
import {cssClasses, strings, numbers} from './constants';
import {animateWithClass, getNormalizedEventCoords} from './util';

const DEACTIVATION_ACTIVATION_PAIRS = {
  mouseup: 'mousedown',
  pointerup: 'pointerdown',
  touchend: 'touchstart',
  keyup: 'keydown',
  blur: 'focus',
};

export default class MDCRippleFoundation extends MDCFoundation {
  static get cssClasses() {
    return cssClasses;
  }

  static get strings() {
    return strings;
  }

  static get numbers() {
    return numbers;
  }

  static get defaultAdapter() {
    return {
      browserSupportsCssVars: () => /* boolean - cached */ {},
      isUnbounded: () => /* boolean */ {},
      isSurfaceActive: () => /* boolean */ {},
      addClass: (/* className: string */) => {},
      removeClass: (/* className: string */) => {},
      registerInteractionHandler: (/* evtType: string, handler: EventListener */) => {},
      deregisterInteractionHandler: (/* evtType: string, handler: EventListener */) => {},
      registerResizeHandler: (/* handler: EventListener */) => {},
      deregisterResizeHandler: (/* handler: EventListener */) => {},
      updateCssVariable: (/* varName: string, value: string */) => {},
      computeBoundingRect: () => /* ClientRect */ {},
      getWindowPageOffset: () => /* {x: number, y: number} */ {},
    };
  }

  // We compute this property so that we are not querying information about the client
  // until the point in time where the foundation requests it. This prevents scenarios where
  // client-side feature-detection may happen too early, such as when components are rendered on the server
  // and then initialized at mount time on the client.
  get isSupported_() {
    return this.adapter_.browserSupportsCssVars();
  }

  constructor(adapter) {
    super(Object.assign(MDCRippleFoundation.defaultAdapter, adapter));
    this.layoutFrame_ = 0;
    this.frame_ = {width: 0, height: 0};
    this.activationState_ = this.defaultActivationState_();
    this.xfDuration_ = 0;
    this.initialSize_ = 0;
    this.maxRadius_ = 0;
    this.listenerInfos_ = [
      {activate: 'touchstart', deactivate: 'touchend'},
      {activate: 'pointerdown', deactivate: 'pointerup'},
      {activate: 'mousedown', deactivate: 'mouseup'},
      {activate: 'keydown', deactivate: 'keyup'},
      {focus: 'focus', blur: 'blur'},
    ];
    this.listeners_ = {
      activate: (e) => this.activate_(e),
      deactivate: (e) => this.deactivate_(e),
      focus: () => requestAnimationFrame(
        () => this.adapter_.addClass(MDCRippleFoundation.cssClasses.BG_ACTIVE)
      ),
      blur: () => requestAnimationFrame(
        () => this.adapter_.removeClass(MDCRippleFoundation.cssClasses.BG_ACTIVE)
      ),
    };
    this.unboundedOpacityFadeTimer_ = 0;
    this.resizeHandler_ = () => this.layout();
    this.cancelBgBounded_ = () => {};
    this.cancelFgBounded_ = () => {};
    this.cancelFgUnbounded_ = () => {};
    this.unboundedCoords_ = {
      left: 0,
      top: 0,
    };
    this.fgScale_ = 0;
  }

  defaultActivationState_() {
    return {
      isActivated: false,
      wasActivatedByPointer: false,
      wasElementMadeActive: false,
      activationStartTime: 0,
      activationEvent: null,
    };
  }

  init() {
    if (!this.isSupported_) {
      return;
    }
    this.addEventListeners_();

    const {ROOT, UNBOUNDED} = MDCRippleFoundation.cssClasses;
    requestAnimationFrame(() => {
      this.adapter_.addClass(ROOT);
      if (this.adapter_.isUnbounded()) {
        this.adapter_.addClass(UNBOUNDED);
      }
      this.layoutInternal_();
    });
  }

  addEventListeners_() {
    this.listenerInfos_.forEach((info) => {
      Object.keys(info).forEach((k) => {
        this.adapter_.registerInteractionHandler(info[k], this.listeners_[k]);
      });
    });
    this.adapter_.registerResizeHandler(this.resizeHandler_);
  }

  activate_(e) {
    const {activationState_: activationState} = this;
    if (activationState.isActivated) {
      return;
    }

    activationState.isActivated = true;
    activationState.activationEvent = e;
    activationState.wasActivatedByPointer = (
      e.type === 'mousedown' || e.type === 'touchstart' || e.type === 'pointerdown'
    );

    activationState.activationStartTime = Date.now();
    requestAnimationFrame(() => {
      // This needs to be wrapped in an rAF call b/c web browsers
      // report active states inconsistently when they're called within
      // event handling code:
      // - https://bugs.chromium.org/p/chromium/issues/detail?id=635971
      // - https://bugzilla.mozilla.org/show_bug.cgi?id=1293741
      activationState.wasElementMadeActive = e.type === 'keydown' ? this.adapter_.isSurfaceActive() : true;
      if (activationState.wasElementMadeActive) {
        this.animateActivation_();
      } else {
        // Reset activation state immediately if element was not made active.
        this.activationState_ = this.defaultActivationState_();
      }
    });
  }

  animateActivation_() {
    const {
      BG_ACTIVE, BG_BOUNDED_ACTIVE_FILL,
      FG_UNBOUNDED_DEACTIVATION, FG_BOUNDED_ACTIVE_FILL,
    } = MDCRippleFoundation.cssClasses;

    // If ripple is currently deactivating, cancel those animations.
    [
      BG_BOUNDED_ACTIVE_FILL,
      FG_UNBOUNDED_DEACTIVATION,
      FG_BOUNDED_ACTIVE_FILL,
    ].forEach((c) => this.adapter_.removeClass(c));
    this.cancelBgBounded_();
    this.cancelFgBounded_();
    this.cancelFgUnbounded_();
    if (this.unboundedOpacityFadeTimer_) {
      clearTimeout(this.unboundedOpacityFadeTimer_);
      this.unboundedOpacityFadeTimer_ = 0;
    }

    this.adapter_.addClass(BG_ACTIVE);
    if (this.adapter_.isUnbounded()) {
      this.animateUnboundedActivation_();
    }
  }

  animateUnboundedActivation_() {
    const {FG_UNBOUNDED_ACTIVATION} = MDCRippleFoundation.cssClasses;
    this.adapter_.addClass(FG_UNBOUNDED_ACTIVATION);
  }

  deactivate_(e) {
    const {activationState_: activationState} = this;
    // This can happen in scenarios such as when you have a keyup event that blurs the element.
    if (!activationState.isActivated) {
      return;
    }
    const actualActivationType = DEACTIVATION_ACTIVATION_PAIRS[e.type];
    const expectedActivationType = activationState.activationEvent.type;
    // NOTE: Pointer events are tricky - https://patrickhlauke.github.io/touch/tests/results/
    // Essentially, what we need to do here is decouple the deactivation UX from the actual
    // deactivation state itself. This way, touch/pointer events in sequence do not trample one
    // another.
    const needsDeactivationUX = actualActivationType === expectedActivationType;
    let needsActualDeactivation = needsDeactivationUX;
    if (activationState.wasActivatedByPointer) {
      needsActualDeactivation = e.type === 'mouseup';
    }

    const state = Object.assign({}, this.activationState_);
    if (needsDeactivationUX) {
      requestAnimationFrame(() => this.animateDeactivation_(e, state));
    }
    if (needsActualDeactivation) {
      this.activationState_ = this.defaultActivationState_();
    }
  }

  animateDeactivation_(e, {wasActivatedByPointer, wasElementMadeActive, activationStartTime}) {
    const {BG_ACTIVE} = MDCRippleFoundation.cssClasses;
    if (wasActivatedByPointer || wasElementMadeActive) {
      this.adapter_.removeClass(BG_ACTIVE);
      const isPointerEvent = (
        e.type === 'touchend' || e.type === 'pointerup' || e.type === 'mouseup'
      );
      if (this.adapter_.isUnbounded()) {
        this.animateUnboundedDeactivation_(this.getUnboundedDeactivationInfo_(activationStartTime));
      } else {
        this.animateBoundedDeactivation_(e, isPointerEvent);
      }
    }
  }

  animateUnboundedDeactivation_({opacityDuration, transformDuration, approxCurScale}) {
    const {
      FG_UNBOUNDED_ACTIVATION,
      FG_UNBOUNDED_DEACTIVATION,
    } = MDCRippleFoundation.cssClasses;
    const {
      VAR_FG_UNBOUNDED_OPACITY_DURATION,
      VAR_FG_UNBOUNDED_TRANSFORM_DURATION,
      VAR_FG_APPROX_XF,
    } = MDCRippleFoundation.strings;
    this.adapter_.updateCssVariable(VAR_FG_APPROX_XF, `scale(${approxCurScale})`);
    this.adapter_.updateCssVariable(VAR_FG_UNBOUNDED_OPACITY_DURATION, `${opacityDuration}ms`);
    this.adapter_.updateCssVariable(VAR_FG_UNBOUNDED_TRANSFORM_DURATION, `${transformDuration}ms`);
    this.adapter_.addClass(FG_UNBOUNDED_DEACTIVATION);
    this.adapter_.removeClass(FG_UNBOUNDED_ACTIVATION);
    // We use setTimeout here since we know how long the fade will take.
    this.unboundedOpacityFadeTimer_ = setTimeout(() => {
      this.adapter_.removeClass(FG_UNBOUNDED_DEACTIVATION);
    }, opacityDuration);
  }

  getUnboundedDeactivationInfo_(activationStartTime) {
    const msElapsed = Date.now() - activationStartTime;
    const {
      FG_TRANSFORM_DELAY_MS, OPACITY_DURATION_DIVISOR,
      ACTIVE_OPACITY_DURATION_MS, UNBOUNDED_TRANSFORM_DURATION_MS,
      MIN_OPACITY_DURATION_MS,
    } = MDCRippleFoundation.numbers;

    let approxCurScale = 0;
    if (msElapsed > FG_TRANSFORM_DELAY_MS) {
      const percentComplete = Math.min((msElapsed - FG_TRANSFORM_DELAY_MS) / this.xfDuration_, 1);
      approxCurScale = percentComplete * this.fgScale_;
    }

    const transformDuration = UNBOUNDED_TRANSFORM_DURATION_MS;
    const approxOpacity = Math.min(msElapsed / ACTIVE_OPACITY_DURATION_MS, 1);
    const opacityDuration = Math.max(
      MIN_OPACITY_DURATION_MS, 1000 * approxOpacity / OPACITY_DURATION_DIVISOR
    );

    return {transformDuration, opacityDuration, approxCurScale};
  }

  animateBoundedDeactivation_(e, isPointerEvent) {
    let startPoint;
    if (isPointerEvent) {
      startPoint = getNormalizedEventCoords(
        e, this.adapter_.getWindowPageOffset(), this.adapter_.computeBoundingRect()
      );
    } else {
      startPoint = {
        x: this.frame_.width / 2,
        y: this.frame_.height / 2,
      };
    }

    startPoint = {
      x: startPoint.x - (this.initialSize_ / 2),
      y: startPoint.y - (this.initialSize_ / 2),
    };

    const endPoint = {
      x: (this.frame_.width / 2) - (this.initialSize_ / 2),
      y: (this.frame_.height / 2) - (this.initialSize_ / 2),
    };

    const {VAR_FG_TRANSLATE_START, VAR_FG_TRANSLATE_END} = MDCRippleFoundation.strings;
    const {BG_BOUNDED_ACTIVE_FILL, FG_BOUNDED_ACTIVE_FILL} = MDCRippleFoundation.cssClasses;
    this.adapter_.updateCssVariable(VAR_FG_TRANSLATE_START, `${startPoint.x}px, ${startPoint.y}px`);
    this.adapter_.updateCssVariable(VAR_FG_TRANSLATE_END, `${endPoint.x}px, ${endPoint.y}px`);
    this.cancelBgBounded_ = animateWithClass(this.adapter_,
                                             BG_BOUNDED_ACTIVE_FILL,
                                            getCorrectEventName(window, 'transitionend'));
    this.cancelFgBounded_ = animateWithClass(this.adapter_,
                                             FG_BOUNDED_ACTIVE_FILL,
                                             getCorrectEventName(window, 'animationend'));
  }

  destroy() {
    if (!this.isSupported_) {
      return;
    }
    this.removeEventListeners_();

    const {ROOT, UNBOUNDED} = MDCRippleFoundation.cssClasses;
    requestAnimationFrame(() => {
      this.adapter_.removeClass(ROOT);
      this.adapter_.removeClass(UNBOUNDED);
      this.removeCssVars_();
    });
  }

  removeEventListeners_() {
    this.listenerInfos_.forEach((info) => {
      Object.keys(info).forEach((k) => {
        this.adapter_.deregisterInteractionHandler(info[k], this.listeners_[k]);
      });
    });
    this.adapter_.deregisterResizeHandler(this.resizeHandler_);
  }

  removeCssVars_() {
    const {strings} = MDCRippleFoundation;
    Object.keys(strings).forEach((k) => {
      if (k.indexOf('VAR_') === 0) {
        this.adapter_.updateCssVariable(strings[k], null);
      }
    });
  }

  layout() {
    if (this.layoutFrame_) {
      cancelAnimationFrame(this.layoutFrame_);
    }
    this.layoutFrame_ = requestAnimationFrame(() => {
      this.layoutInternal_();
      this.layoutFrame_ = 0;
    });
  }

  layoutInternal_() {
    this.frame_ = this.adapter_.computeBoundingRect();

    const maxDim = Math.max(this.frame_.height, this.frame_.width);
    const surfaceDiameter = Math.sqrt(Math.pow(this.frame_.width, 2) + Math.pow(this.frame_.height, 2));

    // 60% of the largest dimension of the surface
    this.initialSize_ = maxDim * MDCRippleFoundation.numbers.INITIAL_ORIGIN_SCALE;

    // Diameter of the surface + 10px
    this.maxRadius_ = surfaceDiameter + MDCRippleFoundation.numbers.PADDING;
    this.fgScale_ = this.maxRadius_ / this.initialSize_;
    this.xfDuration_ = 1000 * Math.sqrt(this.maxRadius_ / 1024);
    this.updateLayoutCssVars_();
  }

  updateLayoutCssVars_() {
    const {
      VAR_SURFACE_WIDTH, VAR_SURFACE_HEIGHT, VAR_FG_SIZE,
      VAR_FG_UNBOUNDED_TRANSFORM_DURATION, VAR_LEFT, VAR_TOP, VAR_FG_SCALE,
    } = MDCRippleFoundation.strings;

    this.adapter_.updateCssVariable(VAR_SURFACE_WIDTH, `${this.frame_.width}px`);
    this.adapter_.updateCssVariable(VAR_SURFACE_HEIGHT, `${this.frame_.height}px`);
    this.adapter_.updateCssVariable(VAR_FG_SIZE, `${this.initialSize_}px`);
    this.adapter_.updateCssVariable(VAR_FG_UNBOUNDED_TRANSFORM_DURATION, `${this.xfDuration_}ms`);
    this.adapter_.updateCssVariable(VAR_FG_SCALE, this.fgScale_);

    if (this.adapter_.isUnbounded()) {
      this.unboundedCoords_ = {
        left: Math.round((this.frame_.width / 2) - (this.initialSize_ / 2)),
        top: Math.round((this.frame_.height / 2) - (this.initialSize_ / 2)),
      };

      this.adapter_.updateCssVariable(VAR_LEFT, `${this.unboundedCoords_.left}px`);
      this.adapter_.updateCssVariable(VAR_TOP, `${this.unboundedCoords_.top}px`);
    }
  }
}
