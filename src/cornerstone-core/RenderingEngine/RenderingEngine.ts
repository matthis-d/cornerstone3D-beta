import EVENTS from './../enums/events'
import renderingEngineCache from './renderingEngineCache'
import eventTarget from '../eventTarget'
import { triggerEvent, uuidv4 } from './../utilities'
import { vtkOffscreenMultiRenderWindow } from './vtkClasses'
import { ViewportInputOptions } from './../types'
import Scene from './Scene'
import Viewport from './Viewport'

/**
 * @type ViewportInput
 * This type defines the shape of input, so we can throw when it is incorrect.
 */
type ViewportInput = {
  canvas: HTMLCanvasElement
  sceneUID: string
  viewportUID: string
  type: string
  defaultOptions: ViewportInputOptions
}

/**
 * A RenderingEngine takes care of the full pipeline of creating viewports and rendering
 * them on a large offscreen canvas and transmitting this data back to the screen. This allows us
 * to leverage the power of vtk.js whilst only using one WebGL context for the processing, and allowing
 * us to share texture memory across on-screen viewports that show the same data.
 *
 * @example
 * Instantiating a rendering engine:
 * ```
 * const renderingEngine = new RenderingEngine('pet-ct-rendering-engine');
 * ```
 *
 * @public
 */
class RenderingEngine {
  readonly uid: string
  public hasBeenDestroyed: boolean
  /**
   * A hook into VTK's `vtkOffscreenMultiRenderWindow`
   * @member {any}
   */
  public offscreenMultiRenderWindow: any
  readonly webGLCanvasContainer: any
  private _scenes: Array<Scene> = []
  private _needsRender: Set<string> = new Set()
  private _animationFrameSet = false
  private _animationFrameHandle: number | null = null

  /**
   *
   * @param uid - Unique identifier for RenderingEngine
   */
  constructor(uid: string) {
    this.uid = uid ? uid : uuidv4()
    renderingEngineCache.set(this)

    this.offscreenMultiRenderWindow = vtkOffscreenMultiRenderWindow.newInstance()
    this.webGLCanvasContainer = document.createElement('div')
    this.offscreenMultiRenderWindow.setContainer(this.webGLCanvasContainer)
    this._scenes = []
    this.hasBeenDestroyed = false
  }

  /**
   * Creates `Scene`s containing `Viewport`s and sets up the offscreen render
   * window to allow offscreen rendering and transmission back to the target
   * canvas in each viewport.
   *
   * @param viewports An array of viewport definitons to construct the rendering engine
   *
   */
  public setViewports(viewports: Array<ViewportInput>): void {
    this._throwIfDestroyed()
    this._reset()

    const { webGLCanvasContainer, offscreenMultiRenderWindow } = this

    // Set canvas size based on height and sum of widths
    const webglCanvasHeight = Math.max(
      ...viewports.map((vp) => vp.canvas.clientHeight)
    )

    let webglCanvasWidth = 0

    viewports.forEach((vp) => {
      webglCanvasWidth += vp.canvas.clientWidth
    })

    webGLCanvasContainer.width = webglCanvasWidth
    webGLCanvasContainer.height = webglCanvasHeight

    offscreenMultiRenderWindow.resize()

    let xOffset = 0

    for (let i = 0; i < viewports.length; i++) {
      const { canvas, sceneUID, viewportUID, type, defaultOptions } = viewports[
        i
      ]

      const { clientWidth, clientHeight } = canvas

      // Set the canvas to be same resolution as the client.
      if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
        canvas.width = clientWidth
        canvas.height = clientHeight
      }

      const { width, height } = canvas

      let scene = this.getScene(sceneUID)

      if (!scene) {
        scene = new Scene(sceneUID, this.uid)

        this._scenes.push(scene)
      }

      // viewport location on source (offscreen) canvas
      const sx = xOffset
      const sy = 0
      const sWidth = width
      const sHeight = height

      // Calculate the position of the renderer in viewport coordinates
      const sxDisplayCoords = sx / webglCanvasWidth

      // Need to offset y if it not max height
      const syDisplayCoords =
        sy + (webglCanvasHeight - height) / webglCanvasHeight

      const sWidthDisplayCoords = sWidth / webglCanvasWidth
      const sHeightDisplayCoords = sHeight / webglCanvasHeight

      offscreenMultiRenderWindow.addRenderer({
        viewport: [
          sxDisplayCoords,
          syDisplayCoords,
          sxDisplayCoords + sWidthDisplayCoords,
          syDisplayCoords + sHeightDisplayCoords,
        ],
        uid: viewportUID,
        background: defaultOptions.background
          ? defaultOptions.background
          : [0, 0, 0],
      })

      scene.addViewport({
        uid: viewportUID,
        type,
        canvas,
        sx,
        sy,
        sWidth,
        sHeight,
        defaultOptions: defaultOptions || {},
      })

      xOffset += width

      const eventData = {
        canvas,
        viewportUID,
        sceneUID,
        renderingEngineUID: this.uid,
      }

      triggerEvent(eventTarget, EVENTS.ELEMENT_ENABLED, eventData)
    }
  }

  /**
   * @method resize Resizes the offscreen viewport and recalculates translations to on screen canvases.
   * It is up to the parent app to call the size of the on-screen canvas changes.
   * This is left as an app level concern as one might want to debounce the changes, or the like.
   */
  public resize() {
    this._throwIfDestroyed()

    const { webGLCanvasContainer, offscreenMultiRenderWindow } = this

    const viewports = []
    const scenes = this._scenes

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const sceneViewports = scene.getViewports()

      viewports.push(...sceneViewports)
    }

    // Set canvas size based on height and sum of widths
    const webglCanvasHeight = Math.max(
      ...viewports.map((vp) => vp.canvas.clientHeight)
    )

    let webglCanvasWidth = 0

    viewports.forEach((vp) => {
      webglCanvasWidth += vp.canvas.clientWidth
    })

    webGLCanvasContainer.width = webglCanvasWidth
    webGLCanvasContainer.height = webglCanvasHeight

    offscreenMultiRenderWindow.resize()

    // Redefine viewport properties
    let xOffset = 0

    for (let i = 0; i < viewports.length; i++) {
      const viewport = viewports[i]
      const { canvas, uid: viewportUID } = viewport
      const { clientWidth, clientHeight } = canvas

      // Set the canvas to be same resolution as the client.
      if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
        canvas.width = clientWidth
        canvas.height = clientHeight
      }

      // Update the canvas drawImage offsets.
      const sx = xOffset
      const sy = 0
      const sWidth = clientWidth
      const sHeight = clientHeight

      viewport.sx = sx
      viewport.sy = sy
      viewport.sWidth = sWidth
      viewport.sHeight = sHeight

      // Set the viewport of the vtkRenderer
      const renderer = offscreenMultiRenderWindow.getRenderer(viewportUID)

      const sxDisplayCoords = sx / webglCanvasWidth

      // Need to offset y if it not max height
      const syDisplayCoords =
        sy + (webglCanvasHeight - clientHeight) / webglCanvasHeight

      const sWidthDisplayCoords = sWidth / webglCanvasWidth
      const sHeightDisplayCoords = sHeight / webglCanvasHeight

      renderer.setViewport([
        sxDisplayCoords,
        syDisplayCoords,
        sxDisplayCoords + sWidthDisplayCoords,
        syDisplayCoords + sHeightDisplayCoords,
      ])

      xOffset += clientWidth
    }

    // Render all viewports
    this.render()
  }

  /**
   * @method getScene Returns the scene.
   * @param {string} uid The UID of the scene to fetch.
   *
   * @returns {Scene} The scene object.
   */
  public getScene(uid: string): Scene {
    this._throwIfDestroyed()

    return this._scenes.find((scene) => scene.uid === uid)
  }

  /**
   * @method getScenes Returns an array of all `Scene`s on the `RenderingEngine` instance.
   *
   * @returns {Scene} The scene object.
   */
  public getScenes(): Array<Scene> {
    this._throwIfDestroyed()

    return this._scenes
  }

  /**
   * @method getViewports Returns an array of all `Viewport`s on the `RenderingEngine` instance.
   *
   * @returns {Viewport} The scene object.
   */
  public getViewports() {
    this._throwIfDestroyed()

    const scenes = this._scenes
    const numScenes = scenes.length
    const viewports = []

    for (let s = 0; s < numScenes; s++) {
      const scene = scenes[s]
      const sceneViewports = scene.getViewports()

      viewports.push(...sceneViewports)
    }

    return viewports
  }

  private _setViewportsToBeRenderedNextFrame(viewportUIDs: string[]) {
    // Add the viewports to the set of flagged viewports
    viewportUIDs.forEach((viewportUID) => {
      this._needsRender.add(viewportUID)
    })

    // Render any flagged viewports
    this._render()
  }

  /**
   * @method render Renders all viewports on the next animation frame.
   */
  public render() {
    const viewports = this.getViewports()
    const viewportUIDs = viewports.map((vp) => vp.uid)

    this._setViewportsToBeRenderedNextFrame(viewportUIDs)
  }

  /**
   * @method _render Sets up animation frame if necessary
   */
  private _render() {
    // If we have viewports that need rendering and we have not already
    // set the RAF callback to run on the next frame.
    if (this._needsRender.size > 0 && this._animationFrameSet === false) {
      this._animationFrameHandle = window.requestAnimationFrame(
        this._renderFlaggedViewports
      )

      // Set the flag that we have already set up the next RAF call.
      this._animationFrameSet = true
    }
  }

  /**
   * @method _renderFlaggedViewports Renders all viewports.
   */
  private _renderFlaggedViewports = () => {
    this._throwIfDestroyed()

    const { offscreenMultiRenderWindow } = this
    const renderWindow = offscreenMultiRenderWindow.getRenderWindow()

    const renderers = offscreenMultiRenderWindow.getRenderers()

    for (let i = 0; i < renderers.length; i++) {
      renderers[i].renderer.setDraw(true)
    }

    renderWindow.render()

    const openGLRenderWindow = offscreenMultiRenderWindow.getOpenGLRenderWindow()
    const context = openGLRenderWindow.get3DContext()

    const offScreenCanvas = context.canvas
    const scenes = this._scenes

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const viewports = scene.getViewports()

      viewports.forEach((viewport) => {
        // Only render viewports which are marked for rerendering
        if (this._needsRender.has(viewport.uid)) {
          this._renderViewportToCanvas(viewport, offScreenCanvas)

          // This viewport has been rendered, we can remove it from the set
          this._needsRender.delete(viewport.uid)

          // If there is nothing left that is flagged for rendering, stop here
          // and allow RAF to be called again
          if (this._needsRender.size === 0) {
            this._animationFrameSet = false
            this._animationFrameHandle = null
            return
          }
        }
      })
    }
  }

  /**
   * @method renderScene Renders only a specific `Scene` on the next animation frame.
   *
   * @param {string} sceneUID The UID of the scene to render.
   */
  public renderScene(sceneUID: string) {
    const scene = this.getScene(sceneUID)
    const viewports = scene.getViewports()
    const viewportUIDs = viewports.map((vp) => vp.uid)

    this._setViewportsToBeRenderedNextFrame(viewportUIDs)
  }

  public renderFrameOfReference = (FrameOfReferenceUID) => {
    const scenes = this._scenes

    const scenesWithFrameOfReferenceUID = scenes.filter(
      (s) => s.getFrameOfReferenceUID() === FrameOfReferenceUID
    )

    return this._renderScenes(scenesWithFrameOfReferenceUID)
  }

  public renderScenes(sceneUIDs: Array<string>) {
    const scenes = sceneUIDs.map((sUid) => this.getScene(sUid))
    return this._renderScenes(scenes)
  }

  public renderViewports(viewportUIDs: Array<string>) {
    this._setViewportsToBeRenderedNextFrame(viewportUIDs)
  }

  private _renderScenes(scenes: Array<Scene>) {
    this._throwIfDestroyed()

    const viewportUIDs = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const viewports = scene.getViewports()
      viewports.forEach((vp) => {
        viewportUIDs.push(vp.uid)
      })
    }

    this._setViewportsToBeRenderedNextFrame(viewportUIDs)
  }

  /**
   * @method renderViewport Renders only a specific `Viewport` on the next animation frame.
   *
   * @param {string} sceneUID The UID of the scene the viewport belongs to.
   * @param {string} viewportUID The UID of the viewport.
   */
  public renderViewport(sceneUID: string, viewportUID: string) {
    this._setViewportsToBeRenderedNextFrame([viewportUID])
  }

  /**
   * @method _renderViewportToCanvas Renders a particular `Viewport`'s on screen canvas.
   * @param {Viewport} viewport The `Viewport` to rendfer.
   * @param {object} offScreenCanvas The offscreen canvas to render from.
   */
  private _renderViewportToCanvas(viewport: Viewport, offScreenCanvas) {
    const {
      sx,
      sy,
      sWidth,
      sHeight,
      uid,
      sceneUID,
      renderingEngineUID,
    } = viewport

    const canvas = <HTMLCanvasElement>viewport.canvas
    const { width: dWidth, height: dHeight } = canvas

    const onScreenContext = canvas.getContext('2d')

    onScreenContext.drawImage(
      offScreenCanvas,
      sx,
      sy,
      sWidth,
      sHeight,
      0, //dx
      0, // dy
      dWidth,
      dHeight
    )

    const eventData = {
      canvas,
      viewportUID: uid,
      sceneUID,
      renderingEngineUID,
    }

    triggerEvent(canvas, EVENTS.IMAGE_RENDERED, eventData)
  }

  /**
   * @method _reset Resets the `RenderingEngine`
   */
  private _reset() {
    const scenes = this.getScenes()
    const renderingEngineUID = this.uid

    scenes.forEach((scene) => {
      const viewports = scene.getViewports()

      const sceneUID = scene.uid

      viewports.forEach((viewport) => {
        const { canvas, uid: viewportUID } = viewport

        const eventData = {
          canvas,
          viewportUID,
          sceneUID,
          renderingEngineUID,
        }

        canvas.removeAttribute('data-viewport-uid')
        canvas.removeAttribute('data-scene-uid')
        canvas.removeAttribute('data-rendering-engine-uid')

        triggerEvent(eventTarget, EVENTS.ELEMENT_DISABLED, eventData)
      })
    })

    window.cancelAnimationFrame(this._animationFrameHandle)

    this._needsRender.clear()
    this._animationFrameSet = false
    this._animationFrameHandle = null

    this._scenes = []
  }

  /**
   * @method destory
   */
  public destroy() {
    if (this.hasBeenDestroyed) {
      return
    }

    this._reset()

    // Free up WebGL resources
    this.offscreenMultiRenderWindow.delete()

    renderingEngineCache.delete(this.uid)

    // Make sure all references go stale and are garbage collected.
    delete this.offscreenMultiRenderWindow

    this.hasBeenDestroyed = true
  }

  /**
   * @method _throwIfDestroyed Throws an error if trying to interact with the `RenderingEngine`
   * instance after its `destroy` method has been called.
   */
  private _throwIfDestroyed() {
    if (this.hasBeenDestroyed) {
      throw new Error(
        'this.destroy() has been manually called to free up memory, can not longer use this instance. Instead make a new one.'
      )
    }
  }

  _debugRender() {
    // Renders all scenes
    const { offscreenMultiRenderWindow } = this
    const renderWindow = offscreenMultiRenderWindow.getRenderWindow()

    const renderers = offscreenMultiRenderWindow.getRenderers()

    for (let i = 0; i < renderers.length; i++) {
      renderers[i].renderer.setDraw(true)
    }

    renderWindow.render()
    const openGLRenderWindow = offscreenMultiRenderWindow.getOpenGLRenderWindow()
    const context = openGLRenderWindow.get3DContext()

    const offScreenCanvas = context.canvas
    const dataURL = offScreenCanvas.toDataURL()
    const scenes = this._scenes

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const viewports = scene.getViewports()

      viewports.forEach((viewport) => {
        const { sx, sy, sWidth, sHeight } = viewport

        const canvas = <HTMLCanvasElement>viewport.canvas
        const { width: dWidth, height: dHeight } = canvas

        const onScreenContext = canvas.getContext('2d')

        //sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight
        onScreenContext.drawImage(
          offScreenCanvas,
          sx,
          sy,
          sWidth,
          sHeight,
          0, //dx
          0, // dy
          dWidth,
          dHeight
        )
      })
    }

    _TEMPDownloadURI(dataURL)
  }
}

export default RenderingEngine

function _TEMPDownloadURI(uri) {
  const link = document.createElement('a')

  link.download = 'viewport.png'
  link.href = uri
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}