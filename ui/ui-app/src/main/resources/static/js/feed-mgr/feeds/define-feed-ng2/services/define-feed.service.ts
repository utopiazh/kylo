import * as _ from "underscore";
import {Inject, Injectable, Injector} from "@angular/core";
import {Feed, FeedMode, FeedTemplateType, LoadMode} from "../../../model/feed/feed.model";
import {Step} from "../../../model/feed/feed-step.model";
import {Common} from "../../../../common/CommonTypes"
import { Templates } from "../../../services/TemplateTypes";
import {Observable} from "rxjs/Observable";
import {StateRegistry, StateService, Transition} from "@uirouter/angular";
import {Subject} from "rxjs/Subject";
import {PreviewDataSet} from "../../../catalog/datasource/preview-schema/model/preview-data-set";
import {HttpClient, HttpParams} from "@angular/common/http";
import {SaveFeedResponse} from "../model/save-feed-response.model";
import "rxjs/add/observable/empty";
import "rxjs/add/observable/of";
import 'rxjs/add/observable/forkJoin'
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/catch';
import {DatasetChangeEvent, PreviewDatasetCollectionService} from "../../../catalog/api/services/preview-dataset-collection.service";
import {TableColumnDefinition} from "../../../model/TableColumnDefinition";
import {TableColumn} from "../../../catalog/datasource/preview-schema/model/table-view-model";
import {EntityAccessControlService} from "../../../shared/entity-access-control/EntityAccessControlService";
import AccessControlService from "../../../../services/AccessControlService";
import {RestUrlConstants} from "../../../services/RestUrlConstants";
import {RegisterTemplatePropertyService} from "../../../services/RegisterTemplatePropertyService";
import {UiComponentsService} from "../../../services/UiComponentsService";
import {FeedService} from "../../../services/FeedService";
import {TableFieldPolicy} from "../../../model/TableFieldPolicy";
import {FeedConstants} from "../../../services/FeedConstants";
import {FeedStepConstants} from "../../../model/feed/feed-step-constants";
import {TranslateService} from "@ngx-translate/core";
import {TdDialogService} from "@covalent/core/dialogs";
import {SelectionService} from "../../../catalog/api/services/selection.service";
import {MatSnackBar} from "@angular/material/snack-bar";
import {PartialObserver} from "rxjs/Observer";
import {ISubscription} from "rxjs/Subscription";
import {SparkDataSet} from "../../../model/spark-data-set.model";
import {FeedStepBuilderUtil} from "./feed-step-builder-util";
import {CloneUtil} from "../../../../common/utils/clone-util";
import {timeout} from 'rxjs/operators/timeout';
import {TimeoutError} from "rxjs/Rx";
import {EntityVersion} from "../../../model/entity-version.model";
import {fromPromise} from "rxjs/observable/fromPromise";
import {ReplaySubject} from "rxjs/ReplaySubject";


export class FeedEditStateChangeEvent{

    public readonly: boolean;
    public allowEdit:boolean;
constructor(readonly:boolean, allowEdit:boolean){
    this.readonly = readonly;
    this.allowEdit = allowEdit;
}

}

export enum TableSchemaUpdateMode {
    UPDATE_SOURCE=1, UPDATE_TARGET=2, UPDATE_SOURCE_AND_TARGET=3
}

@Injectable()
export class DefineFeedService {

    /**
     *
     * The feed in the same state as the server
     * All Steps will get a copy of the feed that they manipulate and save back to this service.
     * This object will get updated after each explicit Load or after a Save
     */
    feed:Feed;

    /**
     * the load mode used for this feed
     */
    feedLoadMode:LoadMode;


    stepSrefMap:Common.Map<Step> = {}

    currentStep:Step

    /**
     * Allow other components to listen for changes to the currentStep
     *
     */
    public currentStep$: Observable<Step>;

    /**
     * The datasets subject for listening
     */
    private currentStepSubject: Subject<Step>;

    /**
     * The datasets subject for listening
     */
    private savedFeedSubject: Subject<SaveFeedResponse>;

    private feedEditStateChangeSubject: Subject<FeedEditStateChangeEvent>;


    private feedLoadedSubject: Subject<Feed>;


    private uiComponentsService :UiComponentsService;


    private feedService :FeedService;

    private accessControlService: AccessControlService;



    constructor(private http:HttpClient,    private _translateService: TranslateService,private $$angularInjector: Injector,
                private _dialogService: TdDialogService,
                private selectionService: SelectionService,
                private snackBar: MatSnackBar,
                @Inject("AccessControlService") accessControlService: AccessControlService){


        this.currentStepSubject = new Subject<Step>();
        this.currentStep$ = this.currentStepSubject.asObservable();

        this.savedFeedSubject = new Subject<SaveFeedResponse>();

        this.feedLoadedSubject = new Subject<Feed>();

        this.uiComponentsService = $$angularInjector.get("UiComponentsService");


        this.feedService = $$angularInjector.get("FeedService");

        this.feedEditStateChangeSubject = new Subject<FeedEditStateChangeEvent>();
        this.accessControlService = accessControlService;


    }


    toPreviewDataSet(dataset:SparkDataSet):PreviewDataSet{
        let existingPreview = dataset.preview || {}
        let preview = new PreviewDataSet(existingPreview);
        preview.displayKey =dataset.id;
        preview.dataSource = dataset.dataSource;
        preview.schema = dataset.schema;
        preview.items = [dataset.previewPath ? dataset.previewPath : dataset.resolvePath()];
        preview.sparkOptions = dataset.options;
        if(preview.sparkOptions) {
            preview.sparkOptions['format'] = dataset.format;
        }
        return preview;

    }



    updateFeedRoleMemberships(roleMemberships: any) {
        this.feed.roleMemberships = roleMemberships;
        this.feed.roleMembershipsUpdated = true;

        //notify subscribers of updated feed role memberships
        let savedFeed = new SaveFeedResponse(this.feed, true, "Updated role memberships");
        this.savedFeedSubject.next(savedFeed);
    }



    /**
     * Load a feed based upon its UUID and return a copy to the subscribers
     *
     * @param {string} id
     * @return {Observable<Feed>}
     */
    loadFeed(id:string, loadMode:LoadMode = LoadMode.LATEST, force?:boolean) :Observable<Feed> {

        let feed = this.getFeed();
        if((feed && (feed.id != id || this.feedLoadMode != loadMode)) || (feed == undefined && id != undefined) || force == true) {
            if(LoadMode.LATEST == loadMode) {
                return this.loadLatestFeed(id);
            }
            else if(LoadMode.DEPLOYED == loadMode){
                return this.loadDeployedFeed(id)
            }
            else if(LoadMode.DRAFT == loadMode){
                return this.loadDraftFeed(id)
            }
        }
        else if(feed){
            return Observable.of(this.feed.copy())
        }
        else {
            return Observable.empty();
        }
    }

    ensureSparkShell(){
        this.http.post(RestUrlConstants.SPARK_SHELL_SERVICE_URL+ "/start", null).subscribe((response)=> {
        },(error1 => {
            console.error("ERROR STARTING spark shell ",error1)
        }));
    }

    loadLatestFeed(feedId:string):Observable<Feed>{
        let url = "/proxy/v1/feedmgr/feeds/"+feedId+"/versions/latest";
        return this._loadFeedVersion(url, LoadMode.LATEST,true)
    }

    loadDeployedFeed(feedId:string):Observable<Feed>{
        let url = "/proxy/v1/feedmgr/feeds/"+feedId+"/versions/deployed";
        return this._loadFeedVersion(url, LoadMode.DEPLOYED,true)
    }

    loadDraftFeed(feedId:string):Observable<Feed>{
        let url = "/proxy/v1/feedmgr/feeds/"+feedId+"/versions/draft";
        return this._loadFeedVersion(url,LoadMode.DRAFT,true)
    }

    getDraftFeed(feedId:string):Observable<Feed>{
        let url = "/proxy/v1/feedmgr/feeds/"+feedId+"/versions/draft";
        return this._loadFeedVersion(url, LoadMode.DRAFT,false)
    }




    /**
     * Save the Feed
     * Users can subscribe to this event via the savedFeedSubject
     * @return {Observable<Feed>}
     */
    saveFeed(feed:Feed) : Observable<SaveFeedResponse>{

        let valid = feed.validate(false);
        //TODO handle validation prevent saving??
        return this._saveFeed(feed);

       // if(feed.isDraft() || (!feed.isDraft() && valid)) {
        //    return this._saveFeed(feed);
       // }
      /**  else {
            //errors exist before we try to save
            //notify watchers that this step was saved
            let response = new SaveFeedResponse(this.feed,false,"Error saving feed "+this.feed.feedName+". You have validation errors");
            // Allow other components to listen for changes to the currentStep
            let  savedFeedSubject: Subject<SaveFeedResponse> = new Subject<SaveFeedResponse>();
            let  savedFeed$: Observable<SaveFeedResponse> = savedFeedSubject.asObservable();
            savedFeedSubject.next(response);
            return savedFeed$;
        }
       */
    }

    deleteFeed():Observable<any> {
        if(this.feed && this.feed.id) {
            return this.http.delete("/proxy/v1/feedmgr/feeds" + "/" + this.feed.id);
        }
        else {
            return Observable.empty();
        }
    }

    /**
     * Set the current step reference and notify any subscribers
     * @param {Step} step
     */
    setCurrentStep(step:Step){
        if(this.currentStep == undefined || this.currentStep != step){
            //notify of change
            this.currentStepSubject.next(step);
        }
        this.currentStep = step;
    }

    getCurrentStep(){
        return this.currentStep;
    }

    subscribeToStepChanges(observer:PartialObserver<Step>) :ISubscription{
      return  this.currentStepSubject.subscribe(observer);
    }

    subscribeToFeedSaveEvent(observer:PartialObserver<SaveFeedResponse>) :ISubscription{
        return  this.savedFeedSubject.subscribe(observer);
    }

    subscribeToFeedEditStateChangeEvent(observer:PartialObserver<FeedEditStateChangeEvent>){
        return this.feedEditStateChangeSubject.subscribe(observer);
    }

    subscribeToFeedLoadedEvent(observer:PartialObserver<Feed>){
        return this.feedLoadedSubject.subscribe(observer);
    }


    markFeedAsEditable(){

        if(this.feed && this.feed.loadMode != LoadMode.DEPLOYED){
            this.feed.readonly = false;
            this.feedEditStateChangeSubject.next(new FeedEditStateChangeEvent(this.feed.readonly,this.feed.allowEdit))
        }
        else if(this.feed && this.feed.loadMode == LoadMode.DEPLOYED){
            console.log("Unable to Edit a deployed feed ",this.feed)
        }
    }

    markFeedAsReadonly(){
        if(this.feed){
            this.feed.readonly = true;
            this.feedEditStateChangeSubject.next(new FeedEditStateChangeEvent(this.feed.readonly,this.feed.allowEdit))
        }
    }

    /**
     * Gets the current feed
     * This is not the copy!!!
     * @return {Feed}
     */
    getFeed(): Feed{
        return this.feed != undefined && this.feed.copy() || undefined;
    }
    /**
     * gets the step from the sRef
     * @param {string} sRef
     * @return {Step}
     */
    getStep(sRef:string): Step{
        return this.stepSrefMap[sRef];
    }

    getStepByIndex(index:number){
        return this.feed.steps[index];
    }

    /**
     * Initialize the Feed Steps based upon the feed template type
     * @param {Feed} feed
     */
    initializeFeedSteps(feed:Feed){
        let templateType = feed.getTemplateType()
        feed.steps = this.getStepsForTemplate(templateType)
    }

    /**
     * Initialize the Feed Steps based upon the feed template type
     * @param {Feed} feed
     */
    getStepsForTemplate(templateType:string){

        let stepUtil = new FeedStepBuilderUtil(this._translateService);
        if(templateType){
            templateType == FeedTemplateType.SIMPLE_FEED;
        }
        if(FeedTemplateType.DEFINE_TABLE == templateType){
            return stepUtil.defineTableFeedSteps();
        }
        else if(FeedTemplateType.DATA_TRANSFORMATION == templateType){
            return stepUtil.dataTransformationSteps()
        }
        else {
            return  stepUtil.simpleFeedSteps();
        }
    }




    /**
     * is the user allowed to leave this component and transition to a new state?
     * @return {boolean}
     */
    uiCanExit(step:Step,newTransition: Transition) :(Promise<any> | boolean) {
        if(step.isDirty()){

            let observable =  this._dialogService.openConfirm({
                message: 'You have unsaved changes.  Are you sure you want to exit? ',
                disableClose: true,
                title: 'Unsaved Changes', //OPTIONAL, hides if not provided
                cancelButton: 'Cancel', //OPTIONAL, defaults to 'CANCEL'
                acceptButton: 'Accept', //OPTIONAL, defaults to 'ACCEPT'
                width: '500px', //OPTIONAL, defaults to 400px
            }).afterClosed();
            observable.subscribe((accept: boolean) => {
                if (accept) {
                    return true;
                } else {
                    // no op
                    return false;
                }
            });
            return observable.toPromise();
        }
        else {
            return true;
        }
    }

    /**
     * Call kylo-services and save the feed
     * @return {Observable<Feed>}
     * @private
     */
    private _saveFeed(feed:Feed) : Observable<SaveFeedResponse>{
        let body = feed.copyModelForSave();

        let subject = new Subject<SaveFeedResponse>();
        let savedFeedObservable$ = subject.asObservable();


        let newFeed = body.id == undefined;
        //remove circular steps
        let steps :Step[] = CloneUtil.deepCopy(body.steps);
        steps.forEach(step => {
            delete step.allSteps;
            delete step.validator;
        })
        //push the steps into the new uiState object on the feed to persist the step status
        body.uiState[Feed.UI_STATE_STEPS_KEY] = JSON.stringify(steps);
        delete body.steps;

        let url = "/proxy/v1/feedmgr/feeds/draft/entity";

        if(!feed.isNew()){
            url = "/proxy/v1/feedmgr/feeds/"+feed.id+"/versions/draft/entity";
        }

        let observable : Observable<Feed> = <Observable<Feed>> this.http.post(url,body,{ headers: {
                'Content-Type': 'application/json; charset=UTF-8'
            }});

        let checkForDraft = !feed.isDraft() ;


        observable.subscribe((response: any)=> {

            let updatedFeed = response;
            //when a feed is initially created it will have the data in the "feedMetadata" property
            if(response.feedMetadata){
                updatedFeed = response.feedMetadata
            }
            //turn the response back into our Feed object
            let savedFeed = new Feed(updatedFeed);
            savedFeed.steps = feed.steps;

            //if the properties are already initialized we should keep those values
            if(feed.propertiesInitialized){
                savedFeed.inputProcessor =  feed.inputProcessor;
                savedFeed.inputProcessors = feed.inputProcessors;
                savedFeed.nonInputProcessors = feed.nonInputProcessors;
            }
           // feedCopy.update(savedFeed);

            //reset it to be editable
            savedFeed.readonly = false;
            savedFeed.allowEdit =true;

            savedFeed.updateDate = new Date(updatedFeed.updateDate);
            let valid = savedFeed.validate(true);

            //notify watchers that this step was saved
            let message = "Successfully saved "+feed.feedName;
            if(!valid){
                message = "Saved the feed, but you have validation errors.  Please review."
            }
            if(checkForDraft){
                //fill in this feeds deployedVersion
                savedFeed.deployedVersion = {id:feed.versionId,name:feed.versionName,createdDate:(feed.createdDate ? feed.createdDate.getDate() : undefined),entityId:feed.id}
            }else if(feed.deployedVersion){
                savedFeed.deployedVersion = feed.deployedVersion;
            }
            this.feed = savedFeed;
            let saveFeedResponse = new SaveFeedResponse(savedFeed,true,message);
            saveFeedResponse.newFeed = newFeed;

            //notify any subscribers to this single function
            subject.next(saveFeedResponse)
            //notify any global subscribers
            this.savedFeedSubject.next(saveFeedResponse);
        },(error: any) => {

            console.error("Error",error);
            let response = new SaveFeedResponse(feed,false,"Error saving feed "+feed.feedName+". You have validation errors");
            //notify any subscribers to this single function
            subject.error(response)
            //notify any global subscribers
            this.savedFeedSubject.error(response);
        });
        return savedFeedObservable$
    }

    deployFeed(feed:Feed) {
        feed.validate(false)
        if(feed.isDraft() && feed.isValid && feed.isComplete()){
            let url = "/proxy/v1/feedmgr/feeds/"+feed.id+"/versions/draft";
            let params :HttpParams = new HttpParams();
            params.set("action","VERSION,DEPLOY")

             this.http.post(url,null,{ params:params}).subscribe((version:EntityVersion) => {
                this.openSnackBar("DEPLOYED VERSION "+version.id,5000)
            });



        }
    }




    public openSnackBar(message:string, duration?:number){
        if(duration == undefined){
            duration = 3000;
        }
        this.snackBar.open(message, null, {
            duration: duration,
        });
    }


    private _loadFeedVersion(url:string, loadMode:LoadMode,load:boolean = true ){
        let loadFeedSubject = new ReplaySubject<Feed>(1);
        let loadFeedObservable$ :Observable<Feed> = loadFeedSubject.asObservable();


        //let observable = <Observable<Feed>> this.http.get("/proxy/v1/feedmgr/feeds/" + id)

        let observable  = <Observable<EntityVersion>> this.http.get(url);
        observable.subscribe((entityVersion:EntityVersion) => {
            let feed:Feed = <Feed>entityVersion.entity;
            feed.mode = entityVersion.name == "draft" ? FeedMode.DRAFT : FeedMode.DEPLOYED;
            feed.versionId = entityVersion.id;
            feed.versionName = entityVersion.name;
            feed.deployedVersion = entityVersion.deployedVersion;
            feed.createdDate = entityVersion.createdDate != null ? new Date(entityVersion.createdDate) : undefined;

            this.selectionService.reset()
            //convert it to our needed class
            let uiState = feed.uiState;

            let feedModel = new Feed(feed)
            //reset the propertiesInitalized flag
            feedModel.propertiesInitialized = false;


            //get the steps back from the model
            let defaultSteps = this.getStepsForTemplate(feedModel.getTemplateType());
            //merge in the saved steps
            let savedStepJSON = feedModel.uiState[Feed.UI_STATE_STEPS_KEY] || "[]";
            let steps :Step[] = JSON.parse(savedStepJSON);
            //group by stepName
            let savedStepMap = _.indexBy(steps,'systemName')
            let mergedSteps:Step[] = defaultSteps.map(step => {
                if(savedStepMap[step.systemName]){
                    step.update(savedStepMap[step.systemName]);
                }
                return step;
            });
            feedModel.steps = mergedSteps;

            feedModel.validate(true);
            feedModel.loadMode = loadMode;
            if(load) {
                console.log('LOADED FEED Version ',entityVersion)
                this.feed = feedModel;
                this.feedLoadMode = loadMode;
            }

            //Check if user has entity access permissions for editing feed
            fromPromise(this.accessControlService.hasPermission(EntityAccessControlService.FEEDS_EDIT, feedModel, EntityAccessControlService.ENTITY_ACCESS.FEED.EDIT_FEED_DETAILS))
                .subscribe((access: boolean) => {
                    //console.log("[debug] Does user have entity access permission to edit feed? " + access);
                    feedModel.allowEdit =  access;
                    if(load) {
                        this.feedEditStateChangeSubject.next(new FeedEditStateChangeEvent(feedModel.readonly, feedModel.allowEdit))
                    }
                });

            if(load) {
                //notify subscribers of a copy
                this.feedLoadedSubject.next(feedModel.copy());
            }
            loadFeedSubject.next(feedModel.copy());
        }, error1 => {
            loadFeedSubject.error(error1)
        })
        return loadFeedObservable$;

    }



}